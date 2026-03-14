import { useState, useRef, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Rocket, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AutocompleteDropdown } from './AutocompleteDropdown';
import { CommandBadge } from './CommandBadge';
import { useAnimateType } from '@/hooks/useAnimateType';
import { useChatHistory } from '@/hooks/useChatHistory';
import type { AutocompleteItem, ColorScheme } from './AutocompleteDropdown';
import type { Skill } from '@/hooks/useSkills';

const stripSlugPrefix = (s: string) => s.replace(/^[a-z]_/, '');

const SKILL_COLORS: Record<string, ColorScheme> = {
  action: 'cyan',
  project: 'amber',
  context_menu: 'violet',
};

interface ConfirmedToken {
  type: 'command' | 'slug';
  value: string;
  start: number;
  end: number;
}

interface TokenSegment {
  type: 'text' | 'command' | 'slug';
  value: string;
  colorScheme?: ColorScheme;
}

function parseTokens(text: string, confirmedTokens: ConfirmedToken[], skills: Skill[]): TokenSegment[] {
  if (confirmedTokens.length === 0) return [{ type: 'text', value: text }];

  const sorted = [...confirmedTokens].sort((a, b) => a.start - b.start);
  const segments: TokenSegment[] = [];
  let cursor = 0;

  for (const token of sorted) {
    if (token.start > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, token.start) });
    }
    let colorScheme: ColorScheme = 'cyan';
    if (token.type === 'command') {
      const skill = skills.find((s) => s.command === token.value);
      colorScheme = SKILL_COLORS[skill?.category ?? 'action'] ?? 'cyan';
    }
    segments.push({ type: token.type, value: token.value, colorScheme });
    cursor = token.end;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }

  return segments;
}

export interface ChatInputHandle {
  animateAndSend: (text: string) => void;
  focus: () => void;
}

interface ChatInputProps {
  onSend?: (message: string) => void;
  placeholder?: string;
  className?: string;
  isLoading?: boolean;
  isTransmitting?: boolean;
  disabled?: boolean;
  assetSlugs?: string[];
  skills?: Skill[];
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend,
    placeholder = 'make a viral video of a dog on a skateboard',
    className,
    isLoading = false,
    isTransmitting = false,
    disabled = false,
    assetSlugs = [],
    skills = [],
  },
  ref
) {
  const [chatInput, setChatInput] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmedTokens, setConfirmedTokens] = useState<ConfirmedToken[]>([]);
  const [historySlide, setHistorySlide] = useState<'up' | 'down' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevTriggerRef = useRef<string | null>(null);

  const { animatingText, isAnimating, startAnimation } = useAnimateType();
  const history = useChatHistory();

  // Expose imperative handle for animate-and-send
  useImperativeHandle(ref, () => ({
    animateAndSend(text: string) {
      history.push(text);
      setChatInput('');
      setConfirmedTokens([]);
      startAnimation(text, () => {
        if (onSend) onSend(text);
        setChatInput('');
        setConfirmedTokens([]);
      });
    },
    focus() {
      inputRef.current?.focus();
    },
  }), [onSend, startAnimation, history]);

  // The displayed text is either animating text or user input
  const displayText = isAnimating ? animatingText : chatInput;

  // Detect active trigger: / at start or after whitespace, or @ anywhere
  const triggerMatch = useMemo(() => {
    if (isAnimating) return null;
    // Check for / trigger
    const slashMatch = chatInput.match(/(^|\s)\/([\w-]*)$/);
    if (slashMatch) {
      return {
        type: 'command' as const,
        filter: slashMatch[2],
        startPos: slashMatch.index! + slashMatch[1].length,
      };
    }
    // Check for @ trigger
    const atMatch = chatInput.match(/@([\w-]*)$/);
    if (atMatch) {
      return { type: 'slug' as const, filter: atMatch[1], startPos: atMatch.index! };
    }
    return null;
  }, [chatInput, isAnimating]);

  // Build autocomplete items
  const autocompleteItems = useMemo((): AutocompleteItem[] => {
    if (!triggerMatch) return [];

    if (triggerMatch.type === 'command') {
      const filter = triggerMatch.filter.toLowerCase();
      return skills
        .filter((s) => s.command.slice(1).toLowerCase().includes(filter))
        .map((s) => ({
          type: 'command' as const,
          value: s.command,
          label: s.command,
          description: s.description,
          example: s.example,
          category: s.category,
          icon: s.icon,
          colorScheme: SKILL_COLORS[s.category] ?? ('cyan' as ColorScheme),
        }));
    }

    // slug type
    const filter = triggerMatch.filter.toLowerCase();
    return assetSlugs
      .filter((slug) => stripSlugPrefix(slug).toLowerCase().includes(filter))
      .map((slug) => ({
        type: 'slug' as const,
        value: slug,
        label: slug,
        description: '',
        colorScheme: 'cyan' as ColorScheme,
      }));
  }, [triggerMatch, skills, assetSlugs]);

  // Reset dismissed/selectedIndex when trigger text changes
  const triggerKey = triggerMatch ? `${triggerMatch.type}:${triggerMatch.filter}` : null;
  if (triggerKey !== prevTriggerRef.current) {
    prevTriggerRef.current = triggerKey;
    if (dismissed) setDismissed(false);
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  const showSuggestions = triggerMatch !== null && autocompleteItems.length > 0 && !dismissed;

  const selectSuggestion = useCallback(
    (item: AutocompleteItem) => {
      if (!triggerMatch) return;
      const before = chatInput.slice(0, triggerMatch.startPos);
      const cursorPos = inputRef.current?.selectionStart ?? chatInput.length;
      const after = chatInput.slice(cursorPos);
      const insertValue = item.value;
      const newValue = before + insertValue + ' ' + after;

      // Add confirmed token
      const token: ConfirmedToken = {
        type: item.type,
        value: insertValue,
        start: before.length,
        end: before.length + insertValue.length,
      };

      // Shift existing tokens that come after
      const shifted = confirmedTokens.map((t) => {
        if (t.start >= triggerMatch.startPos) {
          const delta = newValue.length - chatInput.length;
          return { ...t, start: t.start + delta, end: t.end + delta };
        }
        return t;
      });

      setChatInput(newValue);
      setConfirmedTokens([...shifted, token]);
      setDismissed(true);
      setTimeout(() => {
        inputRef.current?.focus();
        const newCursorPos = before.length + insertValue.length + 1;
        inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    },
    [chatInput, triggerMatch, confirmedTokens]
  );

  const handleSend = useCallback(() => {
    if (!chatInput.trim() || disabled) return;
    history.push(chatInput);
    if (onSend) onSend(chatInput);
    setChatInput('');
    setConfirmedTokens([]);
  }, [chatInput, disabled, onSend, history]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % autocompleteItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + autocompleteItems.length) % autocompleteItems.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectSuggestion(autocompleteItems[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        selectSuggestion(autocompleteItems[selectedIndex]);
      }
    } else if (e.key === 'Enter') {
      handleSend();
    } else if (
      (e.key === 'ArrowUp' && !showSuggestions) ||
      (e.key === 'p' && e.ctrlKey)
    ) {
      const result = history.navigateBack(chatInput);
      if (result !== null) {
        e.preventDefault();
        setChatInput(result);
        setConfirmedTokens([]);
        setHistorySlide('up');
      }
    } else if (
      (e.key === 'ArrowDown' && !showSuggestions) ||
      (e.key === 'n' && e.ctrlKey)
    ) {
      const result = history.navigateForward();
      if (result !== null) {
        e.preventDefault();
        setChatInput(result);
        setConfirmedTokens([]);
        setHistorySlide('down');
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setChatInput(newValue);
    history.reset();

    // Remove confirmed tokens whose text no longer matches
    setConfirmedTokens((prev) =>
      prev.filter((t) => {
        const slice = newValue.slice(t.start, t.end);
        return slice === t.value;
      })
    );
  };

  // Parse tokens for the overlay
  const tokenSegments = useMemo(
    () => parseTokens(displayText, isAnimating ? [] : confirmedTokens, skills),
    [displayText, confirmedTokens, skills, isAnimating]
  );

  const hasConfirmedTokens = confirmedTokens.length > 0 && !isAnimating;

  return (
    <div className={cn('relative flex flex-col gap-0', className)}>
      {/* Autocomplete dropdown */}
      {showSuggestions && (
        <AutocompleteDropdown
          items={autocompleteItems}
          selectedIndex={selectedIndex}
          onSelect={selectSuggestion}
          onHover={setSelectedIndex}
        />
      )}

      {/* Input container */}
      <div
        className={cn(
          'relative flex items-center gap-2 px-3 py-2.5',
          'bg-black/40 border-2 border-primary/30 rounded-lg',
          'shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
          'focus-within:border-primary/60 focus-within:shadow-[inset_0_0_15px_rgba(0,255,255,0.1),0_0_20px_rgba(0,255,255,0.15)]',
          'transition-all duration-300',
          isTransmitting && 'chat-input-transmitting',
          isAnimating && 'chat-input-animating',
          !isTransmitting && !isAnimating && !isLoading && !disabled && 'chat-input-idle',
        )}
      >
        {/* Prompt indicator */}
        <span className="text-primary/60 font-mono text-base font-bold select-none drop-shadow-[0_0_3px_rgba(0,255,255,0.4)]">&rsaquo;</span>

        {/* Input + overlay wrapper */}
        <div
          className={cn(
            'relative flex-1',
            historySlide === 'up' && 'chat-history-up',
            historySlide === 'down' && 'chat-history-down',
          )}
          onAnimationEnd={() => setHistorySlide(null)}
        >
          {/* Real input — transparent text when overlay is active */}
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={displayText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? 'Loading project...' : placeholder}
            className={cn(
              'w-full bg-transparent text-sm font-mono placeholder:text-muted-foreground/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed',
              hasConfirmedTokens ? 'text-transparent caret-foreground/80' : 'text-foreground/80',
              isAnimating && 'text-transparent caret-transparent'
            )}
            data-testid="input-chat"
            disabled={disabled || isLoading || isTransmitting || isAnimating}
          />

          {/* Token overlay — pointer-events-none, styled badges */}
          {(hasConfirmedTokens || isAnimating) && (
            <div
              className="absolute inset-0 flex items-center pointer-events-none text-sm font-mono whitespace-pre"
              aria-hidden="true"
            >
              {isAnimating ? (
                <span className="text-primary/90">{animatingText}</span>
              ) : (
                tokenSegments.map((seg, i) =>
                  seg.type === 'text' ? (
                    <span key={i} className="text-foreground/80">
                      {seg.value}
                    </span>
                  ) : (
                    <CommandBadge key={i} value={seg.value} colorScheme={seg.colorScheme ?? 'cyan'} />
                  )
                )
              )}
            </div>
          )}
        </div>

        {/* Send button */}
        <button
          data-testid="button-generate"
          aria-label={isLoading ? 'Generating' : 'Send message'}
          className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200',
            'border border-primary/20',
            chatInput.trim() && !disabled && !isLoading && !isTransmitting && !isAnimating
              ? 'text-primary bg-primary/10 hover:bg-primary/20 hover:border-primary/40 hover:shadow-[0_0_12px_rgba(0,255,255,0.3)] hover:scale-110'
              : 'text-primary/30',
            'disabled:opacity-30 disabled:cursor-not-allowed'
          )}
          onClick={handleSend}
          disabled={isLoading || isTransmitting || disabled || isAnimating || !chatInput.trim()}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Rocket className="w-4 h-4 -rotate-45" />
          )}
        </button>
      </div>
    </div>
  );
});

import { useState, useRef, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Rocket, Loader2, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AutocompleteDropdown } from './AutocompleteDropdown';
import { CommandBadge } from './CommandBadge';
import { useAnimateType } from '@/hooks/useAnimateType';
import { useChatHistory } from '@/hooks/useChatHistory';
import type { AutocompleteItem, ColorScheme } from './AutocompleteDropdown';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { CommandDescriptor } from '@/lib/command-registry';
import type { UseMcpResult } from 'use-mcp/react';

const stripSlugPrefix = (s: string) => s.replace(/^[a-z]_/, '');

const COMMAND_COLORS: Record<string, ColorScheme> = {
  action: 'cyan',
  project: 'amber',
  context_menu: 'violet',
  viewer: 'cyan',
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

function extractTokens(text: string, commands: CommandDescriptor[], assetSlugs: string[]): ConfirmedToken[] {
  const tokens: ConfirmedToken[] = [];
  const commandSet = new Set(commands.map((s) => s.command));

  // Match /command tokens (at start or after whitespace)
  for (const m of text.matchAll(/(^|\s)(\/[\w-]+)/g)) {
    const value = m[2];
    if (commandSet.has(value)) {
      const start = m.index! + m[1].length;
      tokens.push({ type: 'command', value, start, end: start + value.length });
    }
  }

  // Match slug tokens (bare word matching a known asset slug)
  for (const slug of assetSlugs) {
    const re = new RegExp(`(?<=^|\\s)${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g');
    for (const m of text.matchAll(re)) {
      tokens.push({ type: 'slug', value: slug, start: m.index!, end: m.index! + slug.length });
    }
  }

  return tokens;
}

function parseTokens(text: string, confirmedTokens: ConfirmedToken[], commands: CommandDescriptor[]): TokenSegment[] {
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
      const cmd = commands.find((s) => s.command === token.value);
      colorScheme = COMMAND_COLORS[cmd?.category ?? 'action'] ?? 'cyan';
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
  animateAndEdit: (text: string) => void;
  focus: () => void;
}

type CommandResultPhase = 'transmitting' | 'accepted' | 'rejected' | null;

interface ChatInputProps {
  onSend?: (message: string) => Promise<boolean>;
  placeholder?: string;
  className?: string;
  isLoading?: boolean;
  isTransmitting?: boolean;
  disabled?: boolean;
  assetSlugs?: string[];
  commands?: CommandDescriptor[];
  callTool?: UseMcpResult['callTool'];
  projectSlug?: string;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend: onSendProp,
    placeholder = 'make a viral video of a dog on a skateboard',
    className,
    isLoading = false,
    isTransmitting = false,
    disabled = false,
    assetSlugs = [],
    commands: commandsProp = [],
    callTool,
    projectSlug,
  },
  ref
) {
  const { dispatch: contextDispatch, commands: contextCommands } = useCommandDispatch();
  const onSend = onSendProp ?? contextDispatch;
  const commands = commandsProp.length > 0 ? commandsProp : contextCommands;

  const [chatInput, setChatInput] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmedTokens, setConfirmedTokens] = useState<ConfirmedToken[]>([]);
  const [historySlide, setHistorySlide] = useState<'up' | 'down' | null>(null);
  const [commandResult, setCommandResult] = useState<CommandResultPhase>(null);
  const [resultText, setResultText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const prevTriggerRef = useRef<string | null>(null);
  const resultTimeoutRef = useRef<number>(0);
  const navigatingHistoryRef = useRef(false);

  const { animatingText, isAnimating, startAnimation } = useAnimateType();
  const history = useChatHistory(callTool, projectSlug);

  const runResultSequence = useCallback(async (text: string) => {
    clearTimeout(resultTimeoutRef.current);
    setResultText(text);
    setCommandResult('transmitting');

    let success = false;
    try {
      if (onSend) {
        success = await onSend(text);
      }
    } catch {
      // dispatch may throw on connection errors; treat as rejected
      success = false;
    }

    const phase: CommandResultPhase = success ? 'accepted' : 'rejected';
    const duration = success ? 1200 : 1800;
    setCommandResult(phase);

    resultTimeoutRef.current = window.setTimeout(() => {
      setCommandResult(null);
      setResultText('');
      // Refocus after input re-enables (wait for React DOM commit)
      const focusWhenReady = () => {
        if (inputRef.current && !inputRef.current.disabled) {
          inputRef.current.focus();
        } else {
          requestAnimationFrame(focusWhenReady);
        }
      };
      requestAnimationFrame(focusWhenReady);
    }, duration);
  }, [onSend]);

  // Expose imperative handle for animate-and-send / animate-and-edit
  useImperativeHandle(ref, () => ({
    animateAndSend(text: string) {
      history.push(text);
      setChatInput('');
      setConfirmedTokens([]);
      startAnimation(text, () => {
        setChatInput('');
        setConfirmedTokens([]);
        runResultSequence(text);
      });
    },
    animateAndEdit(text: string) {
      setChatInput('');
      setConfirmedTokens([]);
      startAnimation(text, () => {
        setChatInput(text);
        setConfirmedTokens(extractTokens(text, commands, assetSlugs));
        // Poll until React commits the DOM update (input is no longer disabled)
        const focusWhenReady = () => {
          if (inputRef.current && !inputRef.current.disabled) {
            inputRef.current.focus();
            inputRef.current.setSelectionRange(text.length, text.length);
          } else {
            requestAnimationFrame(focusWhenReady);
          }
        };
        requestAnimationFrame(focusWhenReady);
      });
    },
    focus() {
      inputRef.current?.focus();
    },
  }), [runResultSequence, startAnimation, history, commands, assetSlugs]);

  // The displayed text is either animating text, result text, or user input
  const displayText = isAnimating ? animatingText : commandResult ? resultText : chatInput;

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
      return commands
        .filter((s) => s.command.slice(1).toLowerCase().includes(filter))
        .map((s) => ({
          type: 'command' as const,
          value: s.command,
          label: s.command,
          description: s.description,
          example: s.example,
          category: s.category,
          icon: s.icon,
          colorScheme: COMMAND_COLORS[s.category] ?? ('cyan' as ColorScheme),
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
  }, [triggerMatch, commands, assetSlugs]);

  // Reset dismissed/selectedIndex when trigger text changes
  const triggerKey = triggerMatch ? `${triggerMatch.type}:${triggerMatch.filter}` : null;
  if (triggerKey !== prevTriggerRef.current) {
    prevTriggerRef.current = triggerKey;
    if (dismissed) setDismissed(false);
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  const showSuggestions = triggerMatch !== null && autocompleteItems.length > 0 && !dismissed && !navigatingHistoryRef.current;

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
    const text = chatInput;
    history.push(text);
    setChatInput('');
    setConfirmedTokens([]);
    runResultSequence(text);
  }, [chatInput, disabled, runResultSequence, history]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % autocompleteItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + autocompleteItems.length) % autocompleteItems.length);
      } else if (e.key === 'Enter') {
        const trimmed = chatInput.trim();
        const isCompleteCommand = commands.some(c => trimmed === c.command);
        const selectedItem = autocompleteItems[selectedIndex];
        const selectedMatchesInput = selectedItem?.value === trimmed;
        if (isCompleteCommand && selectedMatchesInput) {
          handleSend();
        } else {
          e.preventDefault();
          selectSuggestion(selectedItem);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        selectSuggestion(autocompleteItems[selectedIndex]);
      }
    } else if (e.key === 'Tab') {
      const files = document.querySelector<HTMLElement>('[data-tabstop="files"]');
      if (files) {
        e.preventDefault();
        files.focus();
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
        navigatingHistoryRef.current = true;
        setChatInput(result);
        setConfirmedTokens(extractTokens(result, commands, assetSlugs));
        setHistorySlide('up');
      }
    } else if (
      (e.key === 'ArrowDown' && !showSuggestions) ||
      (e.key === 'n' && e.ctrlKey)
    ) {
      const result = history.navigateForward();
      if (result !== null) {
        e.preventDefault();
        navigatingHistoryRef.current = true;
        setChatInput(result);
        setConfirmedTokens(extractTokens(result, commands, assetSlugs));
        setHistorySlide('down');
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setChatInput(newValue);
    navigatingHistoryRef.current = false;
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
    () => parseTokens(displayText, isAnimating ? [] : confirmedTokens, commands),
    [displayText, confirmedTokens, commands, isAnimating]
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
          'relative flex items-center gap-2 px-3 py-2.5 overflow-hidden',
          'bg-black/40 border-2 border-primary/30 rounded-lg',
          'shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
          'focus-within:border-primary/60 focus-within:shadow-[inset_0_0_15px_rgba(0,255,255,0.1),0_0_20px_rgba(0,255,255,0.15)]',
          'transition-all duration-300',
          commandResult === 'transmitting' && 'chat-input-transmitting',
          commandResult === 'accepted' && 'chat-input-accepted',
          commandResult === 'rejected' && 'chat-input-rejected',
          !commandResult && isTransmitting && 'chat-input-transmitting',
          !commandResult && isAnimating && 'chat-input-animating',
          !commandResult && !isTransmitting && !isAnimating && !isLoading && !disabled && 'chat-input-idle',
        )}
      >
        {/* Prompt indicator */}
        <span className={cn(
          'font-mono text-base font-bold select-none transition-colors duration-200',
          commandResult === 'accepted' && 'text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.6)]',
          commandResult === 'rejected' && 'text-rose-400 drop-shadow-[0_0_6px_rgba(244,63,94,0.6)]',
          commandResult === 'transmitting' && 'text-primary/80 drop-shadow-[0_0_3px_rgba(0,255,255,0.4)]',
          !commandResult && 'text-primary/60 drop-shadow-[0_0_3px_rgba(0,255,255,0.4)]',
        )}>
          {commandResult === 'accepted' ? '✓' : commandResult === 'rejected' ? '✗' : '›'}
        </span>

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
            onBlur={() => setDismissed(true)}
            placeholder={disabled ? 'Loading project...' : placeholder}
            className={cn(
              'w-full bg-transparent text-sm font-mono placeholder:text-muted-foreground/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed',
              hasConfirmedTokens ? 'text-transparent caret-foreground/80' : 'text-foreground/80',
              isAnimating && 'text-transparent caret-transparent',
              commandResult && 'text-transparent caret-transparent'
            )}
            data-testid="input-chat"
            disabled={disabled || isLoading || isTransmitting || isAnimating || !!commandResult}
          />

          {/* Token overlay — pointer-events-none, styled badges */}
          {(hasConfirmedTokens || isAnimating || commandResult) && (
            <div
              className="absolute inset-0 flex items-center pointer-events-none text-sm font-mono whitespace-pre"
              aria-hidden="true"
            >
              {isAnimating ? (
                <span className="text-primary/90">{animatingText}</span>
              ) : commandResult ? (
                <span className={cn(
                  'transition-colors duration-200',
                  commandResult === 'accepted' && 'text-emerald-400',
                  commandResult === 'rejected' && 'text-rose-400',
                  commandResult === 'transmitting' && 'text-primary/90',
                )}>
                  {resultText}
                </span>
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
          tabIndex={-1}
          data-testid="button-generate"
          aria-label={isLoading ? 'Generating' : 'Send message'}
          className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200',
            'border border-primary/20',
            commandResult === 'accepted'
              ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30'
              : commandResult === 'rejected'
                ? 'text-rose-400 bg-rose-400/10 border-rose-400/30'
                : commandResult === 'transmitting'
                  ? 'text-primary/60'
                  : chatInput.trim() && !disabled && !isLoading && !isTransmitting && !isAnimating
                    ? 'text-primary bg-primary/10 hover:bg-primary/20 hover:border-primary/40 hover:shadow-[0_0_12px_rgba(0,255,255,0.3)] hover:scale-110'
                    : 'text-primary/30',
            'disabled:opacity-30 disabled:cursor-not-allowed'
          )}
          onClick={handleSend}
          disabled={isLoading || isTransmitting || disabled || isAnimating || !!commandResult || !chatInput.trim()}
        >
          {commandResult === 'accepted' ? (
            <Check className="w-4 h-4" />
          ) : commandResult === 'rejected' ? (
            <X className="w-4 h-4" />
          ) : isLoading || commandResult === 'transmitting' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Rocket className="w-4 h-4 -rotate-45" />
          )}
        </button>

        {/* Scan bar sweep during transmitting */}
        {commandResult === 'transmitting' && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-lg">
            <div className="absolute inset-y-0 w-24 chat-input-scan-bar" />
          </div>
        )}
      </div>
    </div>
  );
});

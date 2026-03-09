import { useState, useRef, useMemo } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const stripSlugPrefix = (s: string) => s.replace(/^[a-z]_/, '');

interface ChatInputProps {
  onSend?: (message: string) => void;
  placeholder?: string;
  className?: string;
  isLoading?: boolean;
  isTransmitting?: boolean;
  disabled?: boolean;
  assetSlugs?: string[];
}

export function ChatInput({
  onSend,
  placeholder = 'gen image of a dancing banana',
  className,
  isLoading = false,
  isTransmitting = false,
  disabled = false,
  assetSlugs = [],
}: ChatInputProps) {
  const [chatInput, setChatInput] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const prevTriggerRef = useRef<string | null>(null);

  // Compute the @ trigger match and filter (check for @ at end of input)
  const triggerMatch = useMemo(() => {
    const match = chatInput.match(/@([\w-]*)$/);
    return match ? { filter: match[1], startPos: match.index! } : null;
  }, [chatInput]);

  // Filter suggestions based on trigger
  const filteredSuggestions = useMemo(() => {
    if (!triggerMatch) return [];
    if (assetSlugs.length === 0) return [];
    const filter = triggerMatch.filter.toLowerCase();
    return assetSlugs.filter((slug) => {
      return stripSlugPrefix(slug).toLowerCase().includes(filter);
    });
  }, [triggerMatch, assetSlugs]);

  // Reset dismissed/selectedIndex when trigger text changes
  const triggerKey = triggerMatch?.filter ?? null;
  if (triggerKey !== prevTriggerRef.current) {
    prevTriggerRef.current = triggerKey;
    if (dismissed) setDismissed(false);
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  // Derive visibility
  const showSuggestions = triggerMatch !== null && filteredSuggestions.length > 0 && !dismissed;

  const selectSuggestion = (slug: string) => {
    if (!triggerMatch) return;
    const before = chatInput.slice(0, triggerMatch.startPos);
    const cursorPos = inputRef.current?.selectionStart ?? chatInput.length;
    const after = chatInput.slice(cursorPos);
    const newValue = before + slug + ' ' + after;
    setChatInput(newValue);
    setDismissed(true);
    setTimeout(() => {
      inputRef.current?.focus();
      const newCursorPos = before.length + slug.length + 1;
      inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleSend = () => {
    if (!chatInput.trim() || disabled) return;
    if (onSend) {
      onSend(chatInput);
    }
    setChatInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && filteredSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredSuggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectSuggestion(filteredSuggestions[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        selectSuggestion(filteredSuggestions[selectedIndex]);
      }
    } else if (e.key === 'Enter') {
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setChatInput(e.target.value);
  };

  return (
    <div className={cn('relative flex flex-col gap-0', className)}>
      {/* @ Autocomplete dropdown - positioned above input */}
      {showSuggestions && (
        <div
          ref={suggestionsRef}
          className={cn(
            'absolute bottom-full left-0 right-0 mb-2',
            'bg-background border border-primary/30 rounded-lg shadow-lg overflow-hidden z-50',
            'animate-in fade-in-0 zoom-in-95 duration-150',
            'origin-bottom'
          )}
          data-testid="slug-suggestions"
        >
          <div className="max-h-48 overflow-y-auto">
            {filteredSuggestions.map((slug, index) => (
              <button
                key={slug}
                className={cn(
                  'w-full px-3 py-2 text-left font-mono text-sm transition-colors',
                  index === selectedIndex ? 'bg-primary/20 text-primary' : 'text-foreground hover:bg-white/5'
                )}
                onClick={() => selectSuggestion(slug)}
                onMouseEnter={() => setSelectedIndex(index)}
                data-testid={`slug-suggestion-${slug}`}
              >
                {slug}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Simple terminal-style input */}
      <div
        className={cn(
          'relative flex items-center gap-2 px-3 py-2',
          'bg-black/40 border-2 border-primary/30 rounded-lg',
          'focus-within:border-primary/50 transition-colors',
          isTransmitting && 'chat-input-transmitting'
        )}
      >
        {/* Prompt indicator */}
        <span className="text-primary/40 font-mono text-sm select-none">&rsaquo;</span>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={chatInput}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Loading project...' : placeholder}
          className={cn(
            'flex-1 bg-transparent text-sm font-mono text-foreground/80 placeholder:text-muted-foreground/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed',
            isTransmitting && 'opacity-60'
          )}
          data-testid="input-chat"
          disabled={disabled || isLoading || isTransmitting}
        />

        {/* Send button - small, subtle */}
        <button
          data-testid="button-generate"
          aria-label={isLoading ? 'Generating' : 'Send message'}
          className={cn(
            'w-6 h-6 rounded-full flex items-center justify-center transition-colors',
            'text-primary/40 hover:text-primary hover:bg-primary/10',
            'disabled:opacity-30 disabled:cursor-not-allowed'
          )}
          onClick={handleSend}
          disabled={isLoading || isTransmitting || disabled || !chatInput.trim()}
        >
          {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />}
        </button>
      </div>
    </div>
  );
}

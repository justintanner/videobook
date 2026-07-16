import { useCallback, useRef, useState } from 'react';
import { Loader2, Zap, ChevronDown } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { RewritePlatform, RewriteVariant } from '@/hooks/useRewriteScript';
import { PLATFORM_OPTIONS } from './rewrite-platforms';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import type { UsePromptHistoryResult } from '@/hooks/usePromptHistory';
import { useSlashCommandPicker } from '@/hooks/useSlashCommandPicker';
import { PromptHistoryArrows } from '@/components/ui/PromptHistoryArrows';
import type { UseMcpResult } from 'use-mcp/react';

const CUSTOM_PROMPT_MAX = 500;

export interface RewriteSubmit {
  variant: RewriteVariant;
  platform?: RewritePlatform;
  customPrompt?: string;
}

export interface RewriteInitial {
  variant?: RewriteVariant;
  platform?: RewritePlatform;
  customPrompt?: string;
}

interface RewritePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (args: RewriteSubmit) => void;
  rewriting: boolean;
  disabled?: boolean;
  trigger: React.ReactNode;
  initial?: RewriteInitial | null;
  callTool?: UseMcpResult['callTool'];
  projectSlug?: string;
}

export function RewritePopover(props: RewritePopoverProps) {
  const history = usePromptHistory(props.callTool, 'script_rewrite', props.projectSlug);
  const key = props.open ? 'open' : 'closed';
  return <RewritePopoverState key={key} {...props} history={history} />;
}

function RewritePopoverState({
  open,
  onOpenChange,
  onSubmit,
  rewriting,
  disabled,
  trigger,
  initial,
  history,
}: RewritePopoverProps & { history: UsePromptHistoryResult }) {
  const [variant, setVariant] = useState<RewriteVariant>(initial?.variant ?? 'tldr');
  const [platform, setPlatform] = useState<RewritePlatform | ''>(initial?.platform ?? '');
  const [customPrompt, setCustomPrompt] = useState(initial?.customPrompt ?? '');
  const [historySessionActive, setHistorySessionActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const prepareHistory = useCallback(() => {
    if (historySessionActive) return;
    history.reset();
    setHistorySessionActive(true);
  }, [history, historySessionActive]);

  // Reset draft state whenever popover closes so it always opens fresh
  const handleOpenChange = useCallback((next: boolean) => {
    history.reset();
    if (!next) {
      setVariant('tldr');
      setPlatform('');
      setCustomPrompt('');
    }
    onOpenChange(next);
  }, [onOpenChange, history]);

  const slashPicker = useSlashCommandPicker({
    value: customPrompt,
    setValue: (next) => setCustomPrompt(next.slice(0, CUSTOM_PROMPT_MAX)),
    textareaRef,
    onAfterDispatch: () => onOpenChange(false),
  });

  const submit = useCallback(() => {
    if (rewriting) return;
    const trimmed = customPrompt.trim();
    if (trimmed) {
      history.push(trimmed, {
        variant,
        ...(platform ? { platform } : {}),
      });
    }
    onSubmit({
      variant,
      platform: platform || undefined,
      customPrompt: trimmed || undefined,
    });
  }, [rewriting, onSubmit, variant, platform, customPrompt, history]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashPicker.onKeyDown(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && (textareaRef.current?.selectionStart ?? 0) === 0) {
      prepareHistory();
      const prev = history.navigateBack(customPrompt);
      if (prev !== null) {
        e.preventDefault();
        setCustomPrompt(prev.slice(0, CUSTOM_PROMPT_MAX));
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && (historySessionActive ? history.cursor : -1) !== -1) {
      prepareHistory();
      const next = history.navigateForward();
      if (next !== null) {
        e.preventDefault();
        setCustomPrompt(next.slice(0, CUSTOM_PROMPT_MAX));
      }
    }
  }, [slashPicker, submit, history, customPrompt, historySessionActive, prepareHistory]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCustomPrompt(e.target.value.slice(0, CUSTOM_PROMPT_MAX));
    history.reset();
    setHistorySessionActive(true);
  }, [history]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn(
          'w-96 p-0 rounded border',
          'border-emerald-500/30',
          'bg-black/95 backdrop-blur-sm',
          'text-emerald-200',
          'shadow-[0_0_24px_rgba(245,158,11,0.12)]',
        )}
        onOpenAutoFocus={(e) => {
          // Let the textarea auto-focus instead of the first interactive element
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <div className="flex flex-col gap-3 p-3">
          {/* Header */}
          <div className="flex items-center gap-1.5 text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-300/90">
            <Zap className="w-3.5 h-3.5" />
            Rewrite Script
          </div>

          {/* Variant segmented control */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-500/70 w-14">Length</span>
            <div className="flex rounded overflow-hidden border border-emerald-500/30">
              {(['tldr', 'full'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVariant(v)}
                  disabled={disabled || rewriting}
                  className={cn(
                    'h-7 px-3 text-[11px] font-mono font-bold uppercase tracking-wider',
                    'transition-colors duration-150',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    variant === v
                      ? 'bg-emerald-500/20 text-emerald-200'
                      : 'bg-transparent text-emerald-300/60 hover:bg-emerald-500/10 hover:text-emerald-200',
                  )}
                >
                  {v === 'tldr' ? 'TLDR' : 'Full'}
                </button>
              ))}
            </div>
          </div>

          {/* Platform select */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-500/70 w-14">Platform</span>
            <div className="relative flex-1">
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as RewritePlatform | '')}
                disabled={disabled || rewriting}
                className={cn(
                  'w-full h-7 pl-2.5 pr-7 rounded border appearance-none',
                  'border-emerald-500/30 bg-black/60',
                  'text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-200',
                  'hover:border-emerald-400/60 focus:outline-none focus:ring-1 focus:ring-emerald-400/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
                )}
              >
                {PLATFORM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-black text-emerald-200">
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-emerald-400/70" />
            </div>
          </div>

          {/* Custom prompt textarea */}
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-500/70">Instruction (optional)</span>
              <div className="flex items-center gap-2">
                <PromptHistoryArrows
                  cursor={historySessionActive ? history.cursor : -1}
                  total={history.entries.length}
                  onPrev={() => {
                    prepareHistory();
                    const prev = history.navigateBack(customPrompt);
                    if (prev !== null) setCustomPrompt(prev.slice(0, CUSTOM_PROMPT_MAX));
                  }}
                  onNext={() => {
                    prepareHistory();
                    const next = history.navigateForward();
                    if (next !== null) setCustomPrompt(next.slice(0, CUSTOM_PROMPT_MAX));
                  }}
                  colorClass="text-emerald-400/70"
                />
                <span className="text-[10px] font-mono text-emerald-500/50 tabular-nums">
                  {customPrompt.length}/{CUSTOM_PROMPT_MAX}
                </span>
              </div>
            </div>
            <div className="relative">
              {slashPicker.dropdown}
              <textarea
                ref={textareaRef}
                value={customPrompt}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={disabled || rewriting}
                rows={3}
                placeholder="e.g. replace the pig with a man in a blue suit  (or /help)"
                className={cn(
                  'w-full px-2.5 py-1.5 rounded border resize-none',
                  'border-emerald-500/30 bg-black/60',
                  'text-[12px] font-mono text-emerald-100 placeholder:text-emerald-500/30',
                  'hover:border-emerald-400/60 focus:outline-none focus:ring-1 focus:ring-emerald-400/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              />
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] font-mono text-emerald-500/40">⌘↵ to submit · ↑/↓ history</span>
            <button
              type="button"
              onClick={submit}
              disabled={disabled || rewriting}
              className={cn(
                'h-7 px-3 flex items-center gap-1.5 rounded',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                'text-emerald-200 hover:text-emerald-100',
                'bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/50 hover:border-emerald-300/80',
                'transition-colors duration-150',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {rewriting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Zap className="w-3.5 h-3.5" />}
              Rewrite
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

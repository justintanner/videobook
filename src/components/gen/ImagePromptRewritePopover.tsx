import { useCallback, useRef, useState } from 'react';
import { Loader2, Zap, ChevronDown } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { PLATFORM_OPTIONS } from '@/components/center-stage/rewrite-platforms';
import type { RewritePlatform } from '@/hooks/useRewriteScript';

const CUSTOM_PROMPT_MAX = 500;

export interface ImagePromptRewriteSubmit {
  platform?: RewritePlatform;
  customPrompt?: string;
}

interface ImagePromptRewritePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (args: ImagePromptRewriteSubmit) => void;
  rewriting: boolean;
  disabled?: boolean;
  trigger: React.ReactNode;
}

export function ImagePromptRewritePopover({
  open,
  onOpenChange,
  onSubmit,
  rewriting,
  disabled,
  trigger,
}: ImagePromptRewritePopoverProps) {
  const [platform, setPlatform] = useState<RewritePlatform | ''>('');
  const [customPrompt, setCustomPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setPlatform('');
      setCustomPrompt('');
    }
    onOpenChange(next);
  }, [onOpenChange]);

  const submit = useCallback(() => {
    if (rewriting) return;
    onSubmit({
      platform: platform || undefined,
      customPrompt: customPrompt.trim() || undefined,
    });
  }, [rewriting, onSubmit, platform, customPrompt]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn(
          'w-96 p-0 rounded border',
          'border-amber-500/30',
          'bg-black/95 backdrop-blur-sm',
          'text-amber-200',
          'shadow-[0_0_24px_rgba(245,158,11,0.12)]',
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-mono font-bold uppercase tracking-wider text-amber-300/90">
            <Zap className="w-3.5 h-3.5" />
            Rewrite Image Prompt
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-amber-500/70 w-14">Platform</span>
            <div className="relative flex-1">
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value as RewritePlatform | '')}
                disabled={disabled || rewriting}
                className={cn(
                  'w-full h-7 pl-2.5 pr-7 rounded border appearance-none',
                  'border-amber-500/30 bg-black/60',
                  'text-[11px] font-mono font-bold uppercase tracking-wider text-amber-200',
                  'hover:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
                )}
              >
                {PLATFORM_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-black text-amber-200">
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-amber-400/70" />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-amber-500/70">Instruction (optional)</span>
              <span className="text-[10px] font-mono text-amber-500/50 tabular-nums">
                {customPrompt.length}/{CUSTOM_PROMPT_MAX}
              </span>
            </div>
            <textarea
              ref={textareaRef}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value.slice(0, CUSTOM_PROMPT_MAX))}
              onKeyDown={handleKeyDown}
              disabled={disabled || rewriting}
              rows={3}
              placeholder="e.g. keep the subject centered, remove the blue tint, natural skin"
              className={cn(
                'w-full px-2.5 py-1.5 rounded border resize-none',
                'border-amber-500/30 bg-black/60',
                'text-[12px] font-mono text-amber-100 placeholder:text-amber-500/30',
                'hover:border-amber-400/60 focus:outline-none focus:ring-1 focus:ring-amber-400/60',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] font-mono text-amber-500/40">⌘↵ to submit</span>
            <button
              type="button"
              onClick={submit}
              disabled={disabled || rewriting}
              className={cn(
                'h-7 px-3 flex items-center gap-1.5 rounded',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                'text-amber-200 hover:text-amber-100',
                'bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/50 hover:border-amber-300/80',
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

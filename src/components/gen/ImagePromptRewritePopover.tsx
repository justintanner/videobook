import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Zap, ChevronDown } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { RewritePlatform } from '@/hooks/useRewriteScript';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import { useSlashCommandPicker } from '@/hooks/useSlashCommandPicker';
import { PromptHistoryArrows } from '@/components/ui/PromptHistoryArrows';
import type { UseMcpResult } from 'use-mcp/react';
import { sectionTheme, type Domain } from '@/theme/domains';

const CUSTOM_PROMPT_MAX = 500;

// Style options for the rewrite. The dropdown doubles as the platform selector
// (None/IG/TikTok/YouTube) plus a provider-docs mode that rewrites against the
// useapi.net API documentation instead of a social-platform aesthetic. The two
// modes are mutually exclusive.
type RewriteStyle = RewritePlatform | 'useapi';

const STYLE_OPTIONS: Array<{ value: RewriteStyle | ''; label: string }> = [
  { value: '', label: 'None' },
  { value: 'ig', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'useapi', label: 'Provider docs (useapi.net)' },
];

const USEAPI_MODELS = new Set(['nano_banana', 'gemini_omni']);

function rewriteVariantStyles(domain: 'image' | 'video') {
  const t = sectionTheme(domain as Domain);
  return {
    border: t.headerBorder,
    text: t.valueText,
    textBold: t.activeText,
    label: t.labelText,
    labelTextarea: t.labelText,
    arrowColor: t.headerIcon,
    selectBorder: t.controlBorder,
    selectText: t.valueText,
    selectHover: cn(t.inactiveHoverBorder, t.focusBorder),
    textareaBorder: t.controlBorder,
    textareaText: cn(t.valueText, t.placeholderText),
    textareaHover: cn(t.inactiveHoverBorder, t.focusBorder),
    hint: t.unitText,
    btnText: t.valueText,
    btnBg: cn(t.activeBg, t.activeBorder),
    chevron: t.headerIcon,
  };
}

const VARIANT_STYLES = {
  image: rewriteVariantStyles('image'),
  video: rewriteVariantStyles('video'),
} as const;

export interface ImagePromptRewriteSubmit {
  platform?: RewritePlatform;
  customPrompt?: string;
  providerDocs?: boolean;
}

interface ImagePromptRewritePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (args: ImagePromptRewriteSubmit) => void;
  rewriting: boolean;
  disabled?: boolean;
  trigger: React.ReactNode;
  callTool?: UseMcpResult['callTool'];
  projectSlug?: string;
  model?: string;
  variant?: 'image' | 'video';
}

export function ImagePromptRewritePopover({
  open,
  onOpenChange,
  onSubmit,
  rewriting,
  disabled,
  trigger,
  callTool,
  projectSlug,
  model,
  variant = 'image',
}: ImagePromptRewritePopoverProps) {
  const isVideo = variant === 'video';
  const s = VARIANT_STYLES[variant];
  const [style, setStyle] = useState<RewriteStyle | ''>('');
  const [customPrompt, setCustomPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const history = usePromptHistory(callTool, isVideo ? 'video_rewrite' : 'image_rewrite', projectSlug);

  const visibleStyleOptions = model
    ? STYLE_OPTIONS.filter((opt) => opt.value !== 'useapi' || USEAPI_MODELS.has(model))
    : STYLE_OPTIONS;

  useEffect(() => {
    if (open) history.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setStyle('');
      setCustomPrompt('');
      history.reset();
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
    const providerDocs = isVideo || style === 'useapi';
    const platform = !providerDocs && style ? (style as RewritePlatform) : undefined;
    if (trimmed) {
      history.push(trimmed, {
        ...(model ? { model } : {}),
        ...(platform ? { platform } : {}),
        ...(providerDocs ? { providerDocs: true } : {}),
      });
    }
    onSubmit({
      platform,
      customPrompt: trimmed || undefined,
      providerDocs,
    });
  }, [rewriting, onSubmit, style, customPrompt, history, model, isVideo]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashPicker.onKeyDown(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && (textareaRef.current?.selectionStart ?? 0) === 0) {
      const prev = history.navigateBack(customPrompt);
      if (prev !== null) {
        e.preventDefault();
        setCustomPrompt(prev.slice(0, CUSTOM_PROMPT_MAX));
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && history.cursor !== -1) {
      const next = history.navigateForward();
      if (next !== null) {
        e.preventDefault();
        setCustomPrompt(next.slice(0, CUSTOM_PROMPT_MAX));
      }
    }
  }, [slashPicker, submit, history, customPrompt]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCustomPrompt(e.target.value.slice(0, CUSTOM_PROMPT_MAX));
    history.reset();
  }, [history]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>{trigger}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn(
          'w-96 p-0 rounded border',
          s.border,
          'bg-black/95 backdrop-blur-sm',
          s.text,
          'shadow-[0_0_24px_rgba(245,158,11,0.12)]',
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <div className="flex flex-col gap-3 p-3">
          <div className={cn('flex items-center gap-1.5 text-[11px] font-mono font-bold uppercase tracking-wider',
            s.textBold)}>
            <Zap className="w-3.5 h-3.5" />
            {isVideo ? 'Rewrite Video Prompt' : 'Rewrite Image Prompt'}
          </div>

          {!isVideo && (
            <div className="flex items-center gap-2">
              <span className={cn('text-[10px] font-mono uppercase tracking-wider w-14', s.label)}>Style</span>
              <div className="relative flex-1">
                <select
                  value={style}
                  onChange={(e) => setStyle(e.target.value as RewriteStyle | '')}
                  disabled={disabled || rewriting}
                  className={cn(
                    'w-full h-7 pl-2.5 pr-7 rounded border appearance-none',
                    s.selectBorder,
                    'bg-black/60',
                    cn('text-[11px] font-mono font-bold uppercase tracking-wider', s.selectText),
                    cn(s.selectHover, 'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer'),
                  )}
                >
                  {visibleStyleOptions.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-black">
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className={cn('pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5', s.chevron)} />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className={cn('text-[10px] font-mono uppercase tracking-wider', s.label)}>Instruction (optional)</span>
              <div className="flex items-center gap-2">
                <PromptHistoryArrows
                  cursor={history.cursor}
                  total={history.entries.length}
                  onPrev={() => {
                    const prev = history.navigateBack(customPrompt);
                    if (prev !== null) setCustomPrompt(prev.slice(0, CUSTOM_PROMPT_MAX));
                  }}
                  onNext={() => {
                    const next = history.navigateForward();
                    if (next !== null) setCustomPrompt(next.slice(0, CUSTOM_PROMPT_MAX));
                  }}
                  colorClass={s.arrowColor}
                />
                <span className={cn('text-[10px] font-mono tabular-nums', s.labelTextarea)}>
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
                placeholder={isVideo
                  ? 'e.g. reframe to avoid the filter, keep the cinematic feel  (or /help)'
                  : 'e.g. keep the subject centered, remove the blue tint  (or /help)'}
                className={cn(
                  'w-full px-2.5 py-1.5 rounded border resize-none',
                  s.textareaBorder,
                  'bg-black/60',
                  cn('text-[12px] font-mono', s.textareaText),
                  cn(s.textareaHover, 'disabled:opacity-50 disabled:cursor-not-allowed'),
                )}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className={cn('text-[10px] font-mono', s.hint)}>⌘↵ to submit · ↑/↓ history</span>
            <button
              type="button"
              onClick={submit}
              disabled={disabled || rewriting}
              className={cn(
                'h-7 px-3 flex items-center gap-1.5 rounded',
                'text-[11px] font-mono font-bold uppercase tracking-wider',
                s.btnText,
                s.btnBg,
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

import { useRef } from 'react';
import { Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GenSection, type GenSectionColor } from './GenSection';
import { PromptHistoryArrows } from '@/components/ui/PromptHistoryArrows';
import { ImagePromptRewritePopover, type ImagePromptRewriteSubmit } from '@/components/gen/ImagePromptRewritePopover';
import type { UsePromptHistoryResult } from '@/hooks/usePromptHistory';
import type { UseMcpResult } from 'use-mcp/react';

export interface PromptSectionProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  required?: boolean;
  warning?: string | string[] | null;
  category: 'image' | 'video';
  color?: GenSectionColor;
  promptHistory: UsePromptHistoryResult;
  // Image-only rewrite popover deps
  callTool?: UseMcpResult['callTool'];
  projectSlug?: string;
  selectedModelKey?: string;
  rewriteOpen?: boolean;
  setRewriteOpen?: (next: boolean | ((prev: boolean) => boolean)) => void;
  rewriting?: boolean;
  onRewriteSubmit?: (submit: ImagePromptRewriteSubmit) => void;
  rewriteDisabled?: boolean;
}

const TEXTAREA_COLOR: Record<GenSectionColor, string> = {
  emerald: 'border-emerald-500/15 text-emerald-200 placeholder:text-emerald-400/30 focus:border-emerald-400/40',
  cyan: 'border-cyan-500/15 text-cyan-200 placeholder:text-cyan-400/30 focus:border-cyan-400/40',
  violet: 'border-violet-500/15 text-violet-200 placeholder:text-violet-400/30 focus:border-violet-400/40',
  blue: 'border-blue-500/15 text-blue-200 placeholder:text-blue-400/30 focus:border-blue-400/40',
  fuchsia: 'border-fuchsia-500/15 text-fuchsia-200 placeholder:text-fuchsia-400/30 focus:border-fuchsia-400/40',
};

const REWRITE_COLOR: Record<GenSectionColor, string> = {
  emerald: 'text-emerald-300/90 hover:text-emerald-200 hover:bg-emerald-500/15 border-emerald-500/40 hover:border-emerald-400/70',
  cyan: 'text-cyan-300/90 hover:text-cyan-200 hover:bg-cyan-500/15 border-cyan-500/40 hover:border-cyan-400/70',
  violet: 'text-violet-300/90 hover:text-violet-200 hover:bg-violet-500/15 border-violet-500/40 hover:border-violet-400/70',
  blue: 'text-blue-300/90 hover:text-blue-200 hover:bg-blue-500/15 border-blue-500/40 hover:border-blue-400/70',
  fuchsia: 'text-fuchsia-300/90 hover:text-fuchsia-200 hover:bg-fuchsia-500/15 border-fuchsia-500/40 hover:border-fuchsia-400/70',
};

const REWRITE_OPEN_COLOR: Record<GenSectionColor, string> = {
  emerald: 'bg-emerald-500/15 border-emerald-400/70 text-emerald-200',
  cyan: 'bg-cyan-500/15 border-cyan-400/70 text-cyan-200',
  violet: 'bg-violet-500/15 border-violet-400/70 text-violet-200',
  blue: 'bg-blue-500/15 border-blue-400/70 text-blue-200',
  fuchsia: 'bg-fuchsia-500/15 border-fuchsia-400/70 text-fuchsia-200',
};

const ARROW_COLOR: Record<GenSectionColor, string> = {
  emerald: 'text-emerald-400/70',
  cyan: 'text-cyan-400/70',
  violet: 'text-violet-400/70',
  blue: 'text-blue-400/70',
  fuchsia: 'text-fuchsia-400/70',
};

export function PromptSection({
  value,
  onChange,
  disabled,
  required,
  warning,
  category,
  color = 'emerald',
  promptHistory,
  callTool,
  projectSlug,
  selectedModelKey,
  rewriteOpen = false,
  setRewriteOpen,
  rewriting = false,
  onRewriteSubmit,
  rewriteDisabled,
}: PromptSectionProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  const showRewrite = category === 'image' && setRewriteOpen && onRewriteSubmit;

  const rightSlot = (
    <div className="flex items-center gap-3 h-6">
      <PromptHistoryArrows
        cursor={promptHistory.cursor}
        total={promptHistory.entries.length}
        onPrev={() => {
          const prev = promptHistory.navigateBack(value);
          if (prev !== null) onChange(prev);
        }}
        onNext={() => {
          const next = promptHistory.navigateForward();
          if (next !== null) onChange(next);
        }}
        colorClass={ARROW_COLOR[color]}
      />
      {showRewrite && (
        <ImagePromptRewritePopover
          open={rewriteOpen}
          onOpenChange={setRewriteOpen}
          onSubmit={onRewriteSubmit}
          rewriting={rewriting}
          disabled={(rewriteDisabled ?? false) && !rewriteOpen}
          callTool={callTool}
          projectSlug={projectSlug}
          model={selectedModelKey}
          trigger={
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setRewriteOpen((o) => !o)}
              disabled={rewriteDisabled}
              title="Rewrite prompt to match a platform aesthetic (IG/TikTok/YouTube) and clean up artifacts"
              className={cn(
                'h-6 px-2 flex items-center gap-1.5 rounded',
                'text-[10px] font-mono font-bold uppercase tracking-wider',
                'bg-transparent border',
                'transition-colors duration-150',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                REWRITE_COLOR[color],
                rewriteOpen && REWRITE_OPEN_COLOR[color],
              )}
            >
              {rewriting
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Zap className="w-3 h-3" />}
              Rewrite
            </button>
          }
        />
      )}
    </div>
  );

  return (
    <GenSection
      label="prompt"
      color={color}
      required={required}
      warning={warning}
      rightSlot={rightSlot}
    >
      <textarea
        ref={localRef}
        value={value.replace(/\\n/g, '\n')}
        onChange={(e) => {
          onChange(e.target.value);
          promptHistory.reset();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' && !e.shiftKey && (localRef.current?.selectionStart ?? 0) === 0) {
            const prev = promptHistory.navigateBack(value);
            if (prev !== null) {
              e.preventDefault();
              onChange(prev);
            }
            return;
          }
          if (e.key === 'ArrowDown' && !e.shiftKey && promptHistory.cursor !== -1) {
            const next = promptHistory.navigateForward();
            if (next !== null) {
              e.preventDefault();
              onChange(next);
            }
          }
        }}
        disabled={disabled}
        autoFocus
        rows={4}
        className={cn(
          'w-full px-3 py-2 resize-none bg-black/60 border rounded',
          'font-mono text-sm leading-relaxed',
          'focus:outline-none transition-all duration-200',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          TEXTAREA_COLOR[color],
        )}
      />
    </GenSection>
  );
}

import { Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RichPromptField } from '@/components/ui/RichPromptField';
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

// Per-domain class strings. Sourced from the canonical 5-domain palette in
// src/theme/domains.ts. Tailwind v4's JIT requires class names to be visible
// as literals, so each string is written out per-domain rather than computed.
// Legacy hue keys (cyan/violet/emerald) alias to their corresponding Domain;
// `blue` and `fuchsia` have no Domain mapping yet and stay hardcoded.

const TEXTAREA_PROJECTS = 'border-zinc-500/15 text-zinc-200 placeholder:text-zinc-400/30 focus:border-zinc-400/40';
const TEXTAREA_IMAGE = 'border-cyan-500/15 text-cyan-200 placeholder:text-cyan-400/30 focus:border-cyan-400/40';
const TEXTAREA_VIDEO = 'border-violet-500/15 text-violet-200 placeholder:text-violet-400/30 focus:border-violet-400/40';
const TEXTAREA_PLAN = 'border-emerald-500/15 text-emerald-200 placeholder:text-emerald-400/30 focus:border-emerald-400/40';
const TEXTAREA_FINAL = 'border-amber-500/15 text-amber-200 placeholder:text-amber-400/30 focus:border-amber-400/40';

const TEXTAREA_COLOR: Record<GenSectionColor, string> = {
  projects: TEXTAREA_PROJECTS,
  image: TEXTAREA_IMAGE,
  video: TEXTAREA_VIDEO,
  plan: TEXTAREA_PLAN,
  final: TEXTAREA_FINAL,
  blue: 'border-blue-500/15 text-blue-200 placeholder:text-blue-400/30 focus:border-blue-400/40',
  fuchsia: 'border-fuchsia-500/15 text-fuchsia-200 placeholder:text-fuchsia-400/30 focus:border-fuchsia-400/40',
};

const REWRITE_PROJECTS = 'text-zinc-300/90 hover:text-zinc-200 hover:bg-zinc-500/15 border-zinc-500/40 hover:border-zinc-400/70';
const REWRITE_IMAGE = 'text-cyan-300/90 hover:text-cyan-200 hover:bg-cyan-500/15 border-cyan-500/40 hover:border-cyan-400/70';
const REWRITE_VIDEO = 'text-violet-300/90 hover:text-violet-200 hover:bg-violet-500/15 border-violet-500/40 hover:border-violet-400/70';
const REWRITE_PLAN = 'text-emerald-300/90 hover:text-emerald-200 hover:bg-emerald-500/15 border-emerald-500/40 hover:border-emerald-400/70';
const REWRITE_FINAL = 'text-amber-300/90 hover:text-amber-200 hover:bg-amber-500/15 border-amber-500/40 hover:border-amber-400/70';

const REWRITE_COLOR: Record<GenSectionColor, string> = {
  projects: REWRITE_PROJECTS,
  image: REWRITE_IMAGE,
  video: REWRITE_VIDEO,
  plan: REWRITE_PLAN,
  final: REWRITE_FINAL,
  blue: 'text-blue-300/90 hover:text-blue-200 hover:bg-blue-500/15 border-blue-500/40 hover:border-blue-400/70',
  fuchsia: 'text-fuchsia-300/90 hover:text-fuchsia-200 hover:bg-fuchsia-500/15 border-fuchsia-500/40 hover:border-fuchsia-400/70',
};

const REWRITE_OPEN_PROJECTS = 'bg-zinc-500/15 border-zinc-400/70 text-zinc-200';
const REWRITE_OPEN_IMAGE = 'bg-cyan-500/15 border-cyan-400/70 text-cyan-200';
const REWRITE_OPEN_VIDEO = 'bg-violet-500/15 border-violet-400/70 text-violet-200';
const REWRITE_OPEN_PLAN = 'bg-emerald-500/15 border-emerald-400/70 text-emerald-200';
const REWRITE_OPEN_FINAL = 'bg-amber-500/15 border-amber-400/70 text-amber-200';

const REWRITE_OPEN_COLOR: Record<GenSectionColor, string> = {
  projects: REWRITE_OPEN_PROJECTS,
  image: REWRITE_OPEN_IMAGE,
  video: REWRITE_OPEN_VIDEO,
  plan: REWRITE_OPEN_PLAN,
  final: REWRITE_OPEN_FINAL,
  blue: 'bg-blue-500/15 border-blue-400/70 text-blue-200',
  fuchsia: 'bg-fuchsia-500/15 border-fuchsia-400/70 text-fuchsia-200',
};

const ARROW_PROJECTS = 'text-zinc-400/70';
const ARROW_IMAGE = 'text-cyan-400/70';
const ARROW_VIDEO = 'text-violet-400/70';
const ARROW_PLAN = 'text-emerald-400/70';
const ARROW_FINAL = 'text-amber-400/70';

const ARROW_COLOR: Record<GenSectionColor, string> = {
  projects: ARROW_PROJECTS,
  image: ARROW_IMAGE,
  video: ARROW_VIDEO,
  plan: ARROW_PLAN,
  final: ARROW_FINAL,
  blue: 'text-blue-400/70',
  fuchsia: 'text-fuchsia-400/70',
};

const CARET_COLOR: Record<GenSectionColor, string> = {
  projects: 'caret-zinc-300',
  image: 'caret-cyan-300',
  video: 'caret-violet-300',
  plan: 'caret-emerald-300',
  final: 'caret-amber-300',
  blue: 'caret-blue-300',
  fuchsia: 'caret-fuchsia-300',
};

export function PromptSection({
  value,
  onChange,
  disabled,
  required,
  warning,
  category,
  color = 'plan',
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
      <RichPromptField
        value={value.replace(/\\n/g, '\n')}
        onChange={(next) => {
          onChange(next);
          promptHistory.reset();
        }}
        resolveRef={() => null}
        disabled={disabled}
        autoFocus
        rows={4}
        fieldClassName="w-full px-3 py-2 font-mono text-sm leading-relaxed"
        surfaceClassName={cn(
          'rounded border bg-black/60 transition-all duration-200',
          TEXTAREA_COLOR[color].replace(/\bfocus:/g, 'focus-within:'),
          disabled && 'opacity-50',
        )}
        textClassName={TEXTAREA_COLOR[color]}
        caretClassName={CARET_COLOR[color]}
        onKeyDownExtra={(e) => {
          if (e.key === 'ArrowUp' && !e.shiftKey && (e.currentTarget.selectionStart ?? 0) === 0) {
            const prev = promptHistory.navigateBack(value);
            if (prev !== null) {
              e.preventDefault();
              onChange(prev);
              return true;
            }
          }
          if (e.key === 'ArrowDown' && !e.shiftKey && promptHistory.cursor !== -1) {
            const next = promptHistory.navigateForward();
            if (next !== null) {
              e.preventDefault();
              onChange(next);
              return true;
            }
          }
          return false;
        }}
      />
    </GenSection>
  );
}

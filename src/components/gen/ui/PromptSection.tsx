import { Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RichPromptField } from '@/components/ui/RichPromptField';
import { GenSection, type GenSectionColor } from './GenSection';
import { PromptHistoryArrows } from '@/components/ui/PromptHistoryArrows';
import { ImagePromptRewritePopover, type ImagePromptRewriteSubmit } from '@/components/gen/ImagePromptRewritePopover';
import type { UsePromptHistoryResult } from '@/hooks/usePromptHistory';
import type { UseMcpResult } from 'use-mcp/react';
import type { RichToken } from '@/components/ui/richPromptTokens';
import type { ChipThumb } from '@/components/ui/AssetThumbChip';
import { sectionTheme, type Domain } from '@/theme/domains';

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
  rewriteSupported?: boolean;
  resolveRef?: (token: RichToken) => ChipThumb | null;
  characterMentions?: { handle: string; label: string; ref: string }[];
  characterHandles?: string[];
  onPickCharacter?: (ref: string) => void;
  referenceImageSlots?: { n: number; slug: string; thumbnailSrc: string | null; label: string }[];
  referenceVoiceSlots?: { n: number; ref: string; label: string }[];
  assetMentions?: { slug: string; thumbnailSrc: string | null }[];
  onPickAsset?: (slug: string) => number | null;
}

// Domain keys come from sectionTheme; blue/fuchsia stay as non-domain accents.
const DOMAINS: Domain[] = ['projects', 'image', 'video', 'notebook', 'final'];

function domainTextarea(d: Domain): string {
  const t = sectionTheme(d);
  return cn(t.controlBorder, t.valueText, t.placeholderText, t.focusBorder);
}
function domainRewrite(d: Domain): string {
  const t = sectionTheme(d);
  return cn(t.activeText, t.controlHover, t.controlBorder, t.inactiveHoverBorder);
}
function domainRewriteOpen(d: Domain): string {
  const t = sectionTheme(d);
  return cn(t.activeBg, t.activeBorder, t.valueText);
}
function domainArrow(d: Domain): string {
  return sectionTheme(d).headerIcon;
}

const TEXTAREA_COLOR: Record<GenSectionColor, string> = {
  ...Object.fromEntries(DOMAINS.map((d) => [d, domainTextarea(d)])) as Record<Domain, string>,
  blue: 'border-blue-500/15 text-blue-200 placeholder:text-blue-400/30 focus:border-blue-400/40',
  fuchsia: 'border-fuchsia-500/15 text-fuchsia-200 placeholder:text-fuchsia-400/30 focus:border-fuchsia-400/40',
};

const REWRITE_COLOR: Record<GenSectionColor, string> = {
  ...Object.fromEntries(DOMAINS.map((d) => [d, domainRewrite(d)])) as Record<Domain, string>,
  blue: 'text-blue-300/90 hover:text-blue-200 hover:bg-blue-500/15 border-blue-500/40 hover:border-blue-400/70',
  fuchsia: 'text-fuchsia-300/90 hover:text-fuchsia-200 hover:bg-fuchsia-500/15 border-fuchsia-500/40 hover:border-fuchsia-400/70',
};

const REWRITE_OPEN_COLOR: Record<GenSectionColor, string> = {
  ...Object.fromEntries(DOMAINS.map((d) => [d, domainRewriteOpen(d)])) as Record<Domain, string>,
  blue: 'bg-blue-500/15 border-blue-400/70 text-blue-200',
  fuchsia: 'bg-fuchsia-500/15 border-fuchsia-400/70 text-fuchsia-200',
};

const ARROW_COLOR: Record<GenSectionColor, string> = {
  ...Object.fromEntries(DOMAINS.map((d) => [d, domainArrow(d)])) as Record<Domain, string>,
  blue: 'text-blue-400/70',
  fuchsia: 'text-fuchsia-400/70',
};

// Caret colors are Tailwind caret-* utilities not present on SectionTheme.
const CARET_COLOR: Record<GenSectionColor, string> = {
  projects: 'caret-zinc-300',
  image: 'caret-cyan-300',
  video: 'caret-violet-300',
  notebook: 'caret-emerald-300',
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
  color = 'notebook',
  promptHistory,
  callTool,
  projectSlug,
  selectedModelKey,
  rewriteOpen = false,
  setRewriteOpen,
  rewriting = false,
  onRewriteSubmit,
  rewriteDisabled,
  rewriteSupported,
  resolveRef = () => null,
  characterMentions = [],
  characterHandles = [],
  onPickCharacter,
  referenceImageSlots = [],
  referenceVoiceSlots = [],
  assetMentions = [],
  onPickAsset,
}: PromptSectionProps) {
  const showRewrite = rewriteSupported === true && setRewriteOpen && onRewriteSubmit;

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
          variant={category === 'video' ? 'video' : 'image'}
          trigger={
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setRewriteOpen((o) => !o)}
              disabled={rewriteDisabled}
              title={category === 'video'
                ? 'Rewrite prompt against the Google Flow provider docs (adapts around a prior failure if one exists)'
                : 'Rewrite prompt to match a platform aesthetic (IG/TikTok/YouTube) and clean up artifacts'}
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
 ? <Loader2 className="size-3 animate-spin" />
 : <Zap className="size-3" />}
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
        resolveRef={resolveRef}
        characterMentions={characterMentions}
        characterHandles={characterHandles}
        onPickCharacter={onPickCharacter}
        referenceImageSlots={referenceImageSlots}
        referenceVoiceSlots={referenceVoiceSlots}
        assetMentions={assetMentions}
        onPickAsset={onPickAsset}
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

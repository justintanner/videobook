// The char_swap plan's top-of-flow inputs: the source video + the two characters
// the whole plan is built from. Read straight from the sidecar so they're always
// visible, and editable by dropping a replacement asset on a slot. Because the
// only tool that sets these (plan_visualization) rebuilds the entire plan, a drop
// stages a *pending* change and an explicit Regenerate button commits it — so the
// user controls when the destructive re-split happens (all current swaps are
// replaced). The component is keyed on the committed ids by the parent, so it
// re-seeds from the new plan after a regenerate without a prop-sync effect.
import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import { PlanHeaderSlot } from '@/components/center-stage/PlanViewer';

export interface PlanInputs {
  sourceId: string;
  charAId: string;
  charBId: string;
}

export function PlanInputsNode({
  sourceId,
  charAId,
  charBId,
  mediaItems,
  sourceAspect,
  regenerating,
  onRegenerate,
}: {
  sourceId: string | null;
  charAId: string | null;
  charBId: string | null;
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  regenerating: boolean;
  onRegenerate: (next: PlanInputs) => void;
}) {
  const [stagedSource, setStagedSource] = useState<string | null>(sourceId);
  const [stagedA, setStagedA] = useState<string | null>(charAId);
  const [stagedB, setStagedB] = useState<string | null>(charBId);

  const itemFor = (id: string | null) => (id ? mediaItems.find((m) => m.id === id) ?? null : null);

  const dirty = stagedSource !== sourceId || stagedA !== charAId || stagedB !== charBId;
  const valid = Boolean(stagedSource && stagedA && stagedB) && stagedA !== stagedB;
  const canRegen = dirty && valid && !regenerating;

  const commit = () => {
    if (stagedSource && stagedA && stagedB && stagedA !== stagedB) {
      onRegenerate({ sourceId: stagedSource, charAId: stagedA, charBId: stagedB });
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-3">
        <PlanHeaderSlot label="Video Source" kind="source" item={itemFor(stagedSource)} sourceAspect={sourceAspect} onDrop={setStagedSource} />
        <PlanHeaderSlot label="Char A" kind="character" item={itemFor(stagedA)} onDrop={setStagedA} />
        <PlanHeaderSlot label="Char B" kind="character" item={itemFor(stagedB)} onDrop={setStagedB} />
      </div>
      {dirty && (
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            disabled={!canRegen}
            onClick={commit}
            title="Rebuild the plan from the new source/cast — re-splits scenes and replaces all current swaps"
            className={cn(
              'flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wider border transition-colors',
              canRegen
                ? 'border-emerald-500/60 text-emerald-100 bg-emerald-500/15 hover:bg-emerald-500/25'
                : 'border-zinc-700 text-zinc-500 cursor-not-allowed',
            )}
          >
            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {regenerating ? 'rebuilding…' : 'Regenerate plan'}
          </button>
          <span className={cn('text-[9px] font-mono', valid ? 'text-amber-300/70' : 'text-zinc-500')}>
            {valid ? 'rebuilds all scenes — current swaps are replaced' : 'pick a source video + two distinct characters'}
          </span>
        </div>
      )}
    </div>
  );
}

// The char_swap plan's top-of-flow inputs: the source video + the two characters
// the whole plan is built from. Read straight from the sidecar so they're always
// visible, and editable by dropping a replacement asset on a slot. Because the
// only tool that sets these (plan_visualization) rebuilds the entire plan, a drop
// stages a *pending* change and an explicit Regenerate button commits it — so the
// user controls when the destructive re-split happens (all current swaps are
// replaced). The component is keyed on the committed ids by the parent, so it
// re-seeds from the new plan after a regenerate without a prop-sync effect.
//
// Below the slots, a fan-in connector draws one line from each input down to the
// analysis node (rendered next in the column). Hovering a *filled* line reveals a
// ✕ that clears that slot — the same as dropping a new asset, it stages a pending
// change for the explicit Regenerate.
import { useLayoutEffect, useRef, useState } from 'react';
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

const SLOT_KEYS = ['source', 'a', 'b'] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

const SLOT_LABEL: Record<SlotKey, string> = {
  source: 'video source',
  a: 'character A',
  b: 'character B',
};

export function PlanInputsNode({
  sourceId,
  charAId,
  charBId,
  mediaItems,
  sourceAspect,
  regenerating,
  onRegenerate,
  showConnector,
}: {
  sourceId: string | null;
  charAId: string | null;
  charBId: string | null;
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  regenerating: boolean;
  onRegenerate: (next: PlanInputs) => void;
  // Draw the fan-in lines down to the analysis node (only when it's present below).
  showConnector: boolean;
}) {
  const [stagedSource, setStagedSource] = useState<string | null>(sourceId);
  const [stagedA, setStagedA] = useState<string | null>(charAId);
  const [stagedB, setStagedB] = useState<string | null>(charBId);

  const rowRef = useRef<HTMLDivElement | null>(null);

  const itemFor = (id: string | null) => (id ? mediaItems.find((m) => m.id === id) ?? null : null);

  const dirty = stagedSource !== sourceId || stagedA !== charAId || stagedB !== charBId;
  const valid = Boolean(stagedSource && stagedA && stagedB) && stagedA !== stagedB;
  const canRegen = dirty && valid && !regenerating;

  const commit = () => {
    if (stagedSource && stagedA && stagedB && stagedA !== stagedB) {
      onRegenerate({ sourceId: stagedSource, charAId: stagedA, charBId: stagedB });
    }
  };

  // Clearing an input slot mirrors a drop: it stages a pending change (→ dirty)
  // that the explicit Regenerate commits. A cleared slot is invalid until refilled.
  const clearSlot = (key: SlotKey) => {
    if (key === 'source') setStagedSource(null);
    else if (key === 'a') setStagedA(null);
    else setStagedB(null);
  };

  return (
    <div className="flex w-full flex-col items-center">
      <div ref={rowRef} className="flex flex-wrap justify-center gap-3">
        <div data-input-slot="source">
          <PlanHeaderSlot label="Video Source" kind="source" item={itemFor(stagedSource)} sourceAspect={sourceAspect} onDrop={setStagedSource} />
        </div>
        <div data-input-slot="a">
          <PlanHeaderSlot label="Char A" kind="character" item={itemFor(stagedA)} onDrop={setStagedA} />
        </div>
        <div data-input-slot="b">
          <PlanHeaderSlot label="Char B" kind="character" item={itemFor(stagedB)} onDrop={setStagedB} />
        </div>
      </div>
      {dirty && (
        <div className="mt-2 flex flex-col items-center gap-1">
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
      {showConnector && (
        <InputFanConnector
          rowRef={rowRef}
          filled={{ source: Boolean(stagedSource), a: Boolean(stagedA), b: Boolean(stagedB) }}
          onDelete={clearSlot}
        />
      )}
    </div>
  );
}

// Three SVG lines fanning from each input slot's center down to the column center
// (where the analysis node sits). A straight line per slot — visually identical to
// the old single FlowConnector when read as a group, but now each connection is
// distinct and a filled one can be deleted. Slot x-positions are measured from the
// live DOM (the source slot's width is aspect-driven), re-measured on resize.
function InputFanConnector({
  rowRef,
  filled,
  onDelete,
  height = 48,
}: {
  rowRef: React.RefObject<HTMLDivElement | null>;
  filled: Record<SlotKey, boolean>;
  onDelete: (key: SlotKey) => void;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [geom, setGeom] = useState<{ w: number; xs: Partial<Record<SlotKey, number>> }>({ w: 0, xs: {} });
  const [hovered, setHovered] = useState<SlotKey | null>(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const row = rowRef.current;
    if (!wrap || !row) return;
    const measure = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const xs: Partial<Record<SlotKey, number>> = {};
      for (const key of SLOT_KEYS) {
        const el = row.querySelector<HTMLElement>(`[data-input-slot="${key}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        xs[key] = r.left + r.width / 2 - wrapRect.left;
      }
      setGeom({ w: wrapRect.width, xs });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(row);
    return () => ro.disconnect();
  }, [rowRef]);

  const h = height;
  const cx = geom.w / 2;

  return (
    <div ref={wrapRef} className="relative w-full shrink-0" style={{ height: h }}>
      {geom.w > 0 && (
        <svg width={geom.w} height={h} className="overflow-visible">
          {SLOT_KEYS.map((key) => {
            const x = geom.xs[key];
            if (x == null) return null;
            const isFilled = filled[key];
            const isHot = isFilled && hovered === key;
            const midX = (x + cx) / 2;
            const midY = h / 2;
            const lineColor = isHot
              ? 'rgb(248 113 113 / 0.85)'
              : isFilled
                ? 'rgb(63 63 70 / 0.7)'
                : 'rgb(63 63 70 / 0.35)';
            return (
              <g
                key={key}
                onMouseEnter={isFilled ? () => setHovered(key) : undefined}
                onMouseLeave={isFilled ? () => setHovered((prev) => (prev === key ? null : prev)) : undefined}
                className={isFilled ? 'cursor-pointer' : undefined}
              >
                {/* Wide invisible hit target so the thin line is easy to hover. */}
                {isFilled && <line x1={x} y1={0} x2={cx} y2={h} stroke="transparent" strokeWidth={14} />}
                <line x1={x} y1={0} x2={cx} y2={h} stroke={lineColor} strokeWidth={1} />
                {isHot && (
                  <g onClick={() => onDelete(key)} role="button" aria-label={`Remove ${SLOT_LABEL[key]}`}>
                    <circle cx={midX} cy={midY} r={11} fill="transparent" />
                    <circle cx={midX} cy={midY} r={8} fill="rgb(24 24 27)" stroke="rgb(248 113 113 / 0.9)" strokeWidth={1} />
                    <line x1={midX - 3} y1={midY - 3} x2={midX + 3} y2={midY + 3} stroke="rgb(248 113 113)" strokeWidth={1.5} strokeLinecap="round" />
                    <line x1={midX - 3} y1={midY + 3} x2={midX + 3} y2={midY - 3} stroke="rgb(248 113 113)" strokeWidth={1.5} strokeLinecap="round" />
                    <title>Remove {SLOT_LABEL[key]}</title>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

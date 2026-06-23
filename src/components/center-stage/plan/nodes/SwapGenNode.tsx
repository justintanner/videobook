// Character-swap image gen for one scene frame. Provider/model selectors, a
// per-(provider+model) prompt override, a GUI↔JSON flip, a variant filmstrip
// (click to promote), and "one node → many models" fan-out: Run fires the
// primary model plus any toggled extras sequentially, each landing as its own
// variant. The swap feeds only the character(s) WIRED to this frame (editable
// on the canvas / seeded by vision auto-match), so a row of inline micro-thumbs
// shows exactly what Image 1/2/3(/4) resolve to. Frame 2 threads the prior
// frame-1 swap as continuity reference.
import { memo, useCallback, useMemo, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import { PayloadJsonView } from '@/components/center-stage/PlanViewer';
import { usePlanFlow } from '../PlanFlowContext';
import type { SwapGenNodeData } from './nodeData';
import {
  MODELS_BY_PROVIDER,
  SHORT_LABEL_BY_MODEL,
  buildSwapPayload,
  defaultSwapPrompt,
  deriveTileState,
  frameCharacters,
  variantKey,
  type SwapModel,
  type SwapProvider,
} from '../charSwapModel';
import { FlipCard, FlipToggle, NodeFrame, StateThumb } from './nodeUi';
import { nodeImageHeight } from './nodeLayout';
import { RunButton, Segmented } from './controls';
import { VariantStrip, VARIANT_STRIP_H } from './VariantStrip';

const NODE_WIDTH = 400;
const CONTROLS_H = 170;
const THUMB_STRIP_H = 50;

const PROVIDER_OPTIONS: ReadonlyArray<{ value: SwapProvider; label: string }> = [
  { value: 'kie', label: 'kie' },
  { value: 'fal', label: 'fal' },
];

// One labeled micro-thumb mapping an "Image N" prompt token to its actual
// reference image, so the prompt's "Image 1 / Image 2 …" wording is legible.
// Every input is deletable via its × (onRemove): the source frame resets the
// frame's swap, a character thumb unwires that character, and the prior-frame
// continuity thumb drops continuity. removeTitle carries the per-kind tooltip.
function TokenThumb({ n, src, title, onRemove, removeTitle }: {
  n: number;
  src: string | null;
  title: string;
  onRemove?: () => void;
  removeTitle?: string;
}) {
  return (
    <div className="group relative shrink-0" style={{ width: 36, height: 36 }} title={title}>
      {src ? (
        <img src={src} alt={title} className="w-full h-full object-cover rounded border border-zinc-700" />
      ) : (
        <div className="w-full h-full rounded border border-zinc-700 bg-black/50 flex items-center justify-center">
          <UserRound className="w-4 h-4 text-zinc-600" />
        </div>
      )}
      <span className="absolute -top-1 -left-1 min-w-[12px] h-3 px-0.5 rounded-sm bg-emerald-500/90 text-black text-[8px] font-mono font-bold leading-3 text-center">
        {n}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={removeTitle ?? 'Remove this input'}
          aria-label={removeTitle ?? 'Remove this input'}
          className={cn(
            'nodrag absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full',
            'border border-zinc-600 bg-zinc-900 text-zinc-300 leading-none',
            'hover:border-red-500 hover:bg-red-600 hover:text-white',
          )}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

function SwapGenNodeImpl({ data }: { data: SwapGenNodeData }) {
  const { sidecar, mediaItems, projectSlug, sourceAspect, actions } = usePlanFlow();
  const { sceneIndex, frameIndex } = data;
  const scene = sidecar.scenes[sceneIndex];

  const [provider, setProvider] = useState<SwapProvider>('kie');
  const [model, setModel] = useState<SwapModel>('nano-banana-pro');
  const [extra, setExtra] = useState<Set<SwapModel>>(new Set());
  const [dropActive, setDropActive] = useState(false);
  // Sparse map of user prompt overrides keyed by variantKey; the displayed
  // prompt falls back to the count-aware default so it always reflects how many
  // characters are wired (1 → "Image 2", 2 → "Image 2 and Image 3").
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [flipped, setFlipped] = useState(false);

  const modelOptions = useMemo(
    () => MODELS_BY_PROVIDER[provider].map((m) => ({ value: m, label: SHORT_LABEL_BY_MODEL[m] })),
    [provider],
  );
  const otherModels = useMemo(
    () => MODELS_BY_PROVIDER[provider].filter((m) => m !== model),
    [provider, model],
  );

  const onProviderChange = useCallback((next: SwapProvider) => {
    setProvider(next);
    const supported = MODELS_BY_PROVIDER[next];
    setModel((cur) => (supported.includes(cur) ? cur : supported[0]));
    setExtra((prev) => new Set([...prev].filter((m) => supported.includes(m))));
  }, []);

  const onModelChange = useCallback((next: SwapModel) => {
    setModel(next);
    setExtra((prev) => {
      if (!prev.has(next)) return prev;
      const n = new Set(prev);
      n.delete(next);
      return n;
    });
  }, []);

  const toggleExtra = useCallback((m: SwapModel) => {
    setExtra((prev) => {
      const n = new Set(prev);
      if (n.has(m)) n.delete(m); else n.add(m);
      return n;
    });
  }, []);

  // Characters wired to THIS frame (defaults to all when unwired).
  const wiredChars = useMemo(
    () => frameCharacters(scene, frameIndex, sidecar.characters),
    [scene, frameIndex, sidecar.characters],
  );
  const charCount = wiredChars.length;
  // Frame 2 normally threads frame 1's swap as a continuity reference; the user
  // can delete that input (skip_prior_swap) — then we drop it from the gen and
  // the prompt, and offer a restore chip instead.
  const skipPrior = Boolean(scene?.skip_prior_swap);
  const priorSwapAssetId = frameIndex === 2 && !skipPrior ? (scene?.swap?.image1 ?? undefined) : undefined;
  const canRestorePrior = frameIndex === 2 && skipPrior && Boolean(scene?.swap?.image1);

  // Unwire a character from this frame. Persists the reduced list; removing the
  // last wired character sends an empty set, which clears the wiring so the
  // frame falls back to all roster characters (a swap always needs ≥1 ref).
  const removeChar = useCallback((charId: string) => {
    const next = wiredChars.map((c) => c.asset_id).filter((id) => id !== charId);
    void actions.setFrameCharacters(sceneIndex, frameIndex, next);
  }, [wiredChars, actions, sceneIndex, frameIndex]);

  // Drag a character from the asset sidebar onto this frame to wire it. Reuses
  // the app-wide `application/json` { id } drag payload. We append to the frame's
  // EXPLICIT wiring (not the all-characters fallback), capped at 2 — so dropping
  // onto an unwired frame assigns exactly that character. Non-roster drops are
  // rejected (a swap can only reference this plan's characters).
  const onDropCharacter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    let id: string | null = null;
    try {
      const payload = JSON.parse(json) as { id?: unknown };
      if (typeof payload.id === 'string') id = payload.id.replace(/^@/, '');
    } catch {
      return;
    }
    if (!id) return;
    if (!sidecar.characters.some((c) => c.asset_id === id)) {
      toast({
        title: 'Not a character in this plan',
        description: "Drop one of this plan's characters to wire it into the frame.",
        duration: 4000,
      });
      return;
    }
    const frameKey = `image${frameIndex}` as 'image1' | 'image2';
    const explicit = scene?.frame_characters?.[frameKey] ?? [];
    if (explicit.includes(id)) return;
    void actions.setFrameCharacters(sceneIndex, frameIndex, [...explicit, id].slice(-2));
  }, [sidecar.characters, scene, frameIndex, sceneIndex, actions]);

  const key = variantKey(provider, model);
  const prompt = overrides[key] ?? defaultSwapPrompt(charCount, Boolean(priorSwapAssetId));
  const onPromptChange = useCallback((next: string) => {
    setOverrides((prev) => ({ ...prev, [key]: next }));
  }, [key]);

  const tile = scene ? deriveTileState(scene, frameIndex, mediaItems) : ({ kind: 'idle' } as const);
  const imageH = nodeImageHeight(NODE_WIDTH, sourceAspect, 300);
  const running = actions.isSwapInFlight(sceneIndex, frameIndex);

  const variantsKey = `image${frameIndex}_variants` as 'image1_variants' | 'image2_variants';
  const variants = scene?.swap?.[variantsKey];
  const selectedAssetId = scene?.swap?.[`image${frameIndex}` as 'image1' | 'image2'] ?? null;
  const hasVariants = !!variants && Object.keys(variants).length > 0;

  // Inline Image-token thumbs: 1 = source frame, 2/3 = wired chars, then prior.
  // Every thumb carries a `kind` so render attaches the right × delete action
  // (source → reset frame, char → unwire, prior → drop continuity).
  type TokenKind = 'source' | 'char' | 'prior';
  const tokenThumbs = useMemo(() => {
    const cacheBust = scene ? `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}` : '';
    const out: Array<{ n: number; src: string | null; title: string; kind: TokenKind; charId?: string }> = [
      {
        n: 1,
        src: `/files/${projectSlug}/plan/s${sceneIndex + 1}-image${frameIndex}-source.jpg?v=${cacheBust}`,
        title: 'Image 1 — source frame',
        kind: 'source',
      },
    ];
    wiredChars.forEach((c, i) => {
      const item = mediaItems.find((m) => m.id === c.asset_id);
      out.push({ n: i + 2, src: item?.thumbnailSrc ?? item?.filePath ?? null, title: `Image ${i + 2} — ${c.name}`, kind: 'char', charId: c.asset_id });
    });
    if (priorSwapAssetId) {
      const item = mediaItems.find((m) => m.id === priorSwapAssetId);
      out.push({
        n: wiredChars.length + 2,
        src: item?.thumbnailSrc ?? item?.filePath ?? `/files/${projectSlug}/${priorSwapAssetId}/original.png`,
        title: `Image ${wiredChars.length + 2} — prior frame (continuity)`,
        kind: 'prior',
      });
    }
    return out;
  }, [scene, projectSlug, sceneIndex, frameIndex, wiredChars, mediaItems, priorSwapAssetId]);

  const payload = useMemo(
    () => buildSwapPayload(provider, model, wiredChars, sceneIndex, frameIndex, prompt, sourceAspect, priorSwapAssetId),
    [provider, model, wiredChars, sceneIndex, frameIndex, prompt, sourceAspect, priorSwapAssetId],
  );

  // Run the primary model plus any toggled extras, sequentially (each enqueues
  // its own job; sequential await respects the server git mutex). Each lands as
  // a variant in image{N}_variants.
  const runModels = useMemo(() => [model, ...otherModels.filter((m) => extra.has(m))], [model, otherModels, extra]);
  const run = useCallback(() => {
    void (async () => {
      for (const m of runModels) {
        const k = variantKey(provider, m);
        const p = overrides[k] ?? defaultSwapPrompt(charCount, Boolean(priorSwapAssetId));
        await actions.runSwap(sceneIndex, frameIndex, provider, m, {
          customPrompt: p,
          ...(priorSwapAssetId ? { priorSwapAssetId } : {}),
        });
      }
    })();
  }, [actions, runModels, sceneIndex, frameIndex, provider, overrides, charCount, priorSwapAssetId]);

  if (!scene) return null;

  // Map a token thumb to its × delete behaviour. A char needs ≥1 reference, so
  // its × only shows when removing actually changes the gen (another wired char,
  // or other roster chars to fall back to). The source × only shows once a swap
  // exists to reset. The prior thumb is always droppable.
  function removalFor(t: { kind: TokenKind; charId?: string }): { onRemove?: () => void; removeTitle?: string } {
    if (t.kind === 'char') {
      if (charCount > 1 || sidecar.characters.length > 1) {
        return { onRemove: () => removeChar(t.charId as string), removeTitle: 'Remove this character from the frame' };
      }
      return {};
    }
    if (t.kind === 'source') {
      if (selectedAssetId || hasVariants) {
        return { onRemove: () => { void actions.clearFrameSwap(sceneIndex, frameIndex); }, removeTitle: 'Reset this frame (clear the swap)' };
      }
      return {};
    }
    return { onRemove: () => { void actions.setSkipPrior(sceneIndex, true); }, removeTitle: 'Drop the prior-frame continuity reference' };
  }

  const front = (
    <div>
      <StateThumb tile={tile} heightPx={imageH} idleText="no swap yet" alt={data.label} />
      {hasVariants && (
        <VariantStrip
          variants={variants}
          selectedAssetId={selectedAssetId}
          mediaItems={mediaItems}
          onPick={(assetId) => { void actions.promoteVariant(sceneIndex, frameIndex, assetId); }}
        />
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true); }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDropCharacter}
        title="Drag a character from the sidebar to wire it into this frame"
        className={cn(
          'mt-2 flex items-center gap-2 flex-wrap rounded p-1 -m-1 transition-colors',
          dropActive ? 'ring-1 ring-violet-400/70 bg-violet-500/10' : 'ring-1 ring-transparent',
        )}
      >
        {tokenThumbs.map((t) => {
          const removal = removalFor(t);
          return (
            <TokenThumb
              key={t.n}
              n={t.n}
              src={t.src}
              title={t.title}
              onRemove={removal.onRemove}
              removeTitle={removal.removeTitle}
            />
          );
        })}
        {charCount === 1 && (
          <span className="text-[9px] font-mono text-violet-300/60 leading-tight">
            1 char · drag a character from the sidebar to add
          </span>
        )}
        {canRestorePrior && (
          <button
            type="button"
            onClick={() => { void actions.setSkipPrior(sceneIndex, false); }}
            title="Restore the prior-frame continuity reference"
            className="nodrag text-[9px] font-mono text-amber-300/70 hover:text-amber-200 leading-tight underline decoration-dotted"
          >
            continuity off · restore
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Segmented options={PROVIDER_OPTIONS} value={provider} onChange={onProviderChange} ariaLabel="provider" />
          <Segmented options={modelOptions} value={model} onChange={onModelChange} ariaLabel="model" />
        </div>
        {otherModels.length > 0 && (
          <div className="nodrag flex items-center gap-1 flex-wrap">
            <span className="text-[9px] font-mono text-zinc-500">+also</span>
            {otherModels.map((m) => {
              const on = extra.has(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleExtra(m)}
                  className={cn(
                    'px-1 py-0.5 rounded text-[9px] font-mono border transition-colors',
                    on ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/50' : 'bg-black/40 text-zinc-400 border-zinc-700 hover:text-zinc-200',
                  )}
                >
                  {SHORT_LABEL_BY_MODEL[m]}
                </button>
              );
            })}
          </div>
        )}
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={3}
          spellCheck={false}
          className={cn(
            'nodrag w-full resize-none rounded bg-black/60 border border-zinc-700 px-1.5 py-1',
            'text-[10px] font-mono text-emerald-100/90 leading-snug',
            'focus:outline-none focus:border-emerald-500/60 scrollbar-hide',
          )}
        />
        <div className="flex items-center justify-end">
          <RunButton
            onClick={run}
            running={running}
            label={runModels.length > 1 ? `Run ${runModels.length}` : 'Run'}
            title={`Run ${runModels.map((m) => SHORT_LABEL_BY_MODEL[m]).join(', ')} (${provider})`}
          />
        </div>
      </div>
    </div>
  );

  const flipHeight = imageH + (hasVariants ? VARIANT_STRIP_H + 6 : 0) + THUMB_STRIP_H + CONTROLS_H;

  return (
    <NodeFrame
      label={data.label}
      accent="border-emerald-600/50"
      width={NODE_WIDTH}
      badge={<FlipToggle flipped={flipped} onToggle={() => setFlipped((f) => !f)} />}
    >
      <FlipCard
        flipped={flipped}
        height={flipHeight}
        front={front}
        back={<PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />}
      />
    </NodeFrame>
  );
}

export const SwapGenNode = memo(SwapGenNodeImpl);

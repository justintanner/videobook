// Character-swap image gen for one scene frame. Provider/model selectors, a
// per-(provider+model) prompt override, a GUI↔JSON flip, a variant filmstrip
// (click to promote), and "one node → many models" fan-out: Run fires the
// primary model plus any toggled extras sequentially, each landing as its own
// variant. The swap feeds only the character(s) WIRED to this frame (editable
// on the canvas / seeded by vision auto-match), so a row of inline micro-thumbs
// shows exactly what Image 1/2/3(/4) resolve to. Frame 2 threads the prior
// frame-1 swap as continuity reference.
import { memo, useCallback, useMemo, useState } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PayloadJsonView } from '@/components/center-stage/PlanViewer';
import { usePlanFlow } from '../PlanFlowContext';
import type { SwapGenNodeData } from '../buildPlanGraph';
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

const NODE_WIDTH = 340;
const CONTROLS_H = 150;
const THUMB_STRIP_H = 42;

const PROVIDER_OPTIONS: ReadonlyArray<{ value: SwapProvider; label: string }> = [
  { value: 'kie', label: 'kie' },
  { value: 'fal', label: 'fal' },
];

// One labeled micro-thumb mapping an "Image N" prompt token to its actual
// reference image, so the prompt's "Image 1 / Image 2 …" wording is legible.
function TokenThumb({ n, src, title }: { n: number; src: string | null; title: string }) {
  return (
    <div className="relative shrink-0" style={{ width: 30, height: 30 }} title={title}>
      {src ? (
        <img src={src} alt={title} className="w-full h-full object-cover rounded border border-zinc-700" />
      ) : (
        <div className="w-full h-full rounded border border-zinc-700 bg-black/50 flex items-center justify-center">
          <UserRound className="w-3.5 h-3.5 text-zinc-600" />
        </div>
      )}
      <span className="absolute -top-1 -left-1 min-w-[12px] h-3 px-0.5 rounded-sm bg-emerald-500/90 text-black text-[8px] font-mono font-bold leading-3 text-center">
        {n}
      </span>
    </div>
  );
}

function SwapGenNodeImpl({ data }: NodeProps<Node<SwapGenNodeData>>) {
  const { sidecar, mediaItems, projectSlug, sourceAspect, actions } = usePlanFlow();
  const { sceneIndex, frameIndex } = data;
  const scene = sidecar.scenes[sceneIndex];

  const [provider, setProvider] = useState<SwapProvider>('kie');
  const [model, setModel] = useState<SwapModel>('nano-banana-pro');
  const [extra, setExtra] = useState<Set<SwapModel>>(new Set());
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
  const priorSwapAssetId = frameIndex === 2 ? (scene?.swap?.image1 ?? undefined) : undefined;

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
  const tokenThumbs = useMemo(() => {
    const cacheBust = scene ? `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}` : '';
    const out: Array<{ n: number; src: string | null; title: string }> = [
      {
        n: 1,
        src: `/files/${projectSlug}/plan/s${sceneIndex + 1}-image${frameIndex}-source.jpg?v=${cacheBust}`,
        title: 'Image 1 — source frame',
      },
    ];
    wiredChars.forEach((c, i) => {
      const item = mediaItems.find((m) => m.id === c.asset_id);
      out.push({ n: i + 2, src: item?.thumbnailSrc ?? item?.filePath ?? null, title: `Image ${i + 2} — ${c.name}` });
    });
    if (priorSwapAssetId) {
      const item = mediaItems.find((m) => m.id === priorSwapAssetId);
      out.push({
        n: wiredChars.length + 2,
        src: item?.thumbnailSrc ?? item?.filePath ?? `/files/${projectSlug}/${priorSwapAssetId}/original.png`,
        title: `Image ${wiredChars.length + 2} — prior frame (continuity)`,
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
      <div className="mt-2 flex items-center gap-1.5">
        {tokenThumbs.map((t) => (
          <TokenThumb key={t.n} n={t.n} src={t.src} title={t.title} />
        ))}
        {charCount === 1 && (
          <span className="text-[8px] font-mono text-violet-300/60 leading-tight">1 char wired</span>
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
          rows={2}
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

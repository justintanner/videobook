// Character-swap image gen for one scene frame. One shared prompt, a GUI↔JSON
// flip, a variant filmstrip (click to promote), and a direct "Run <model>"
// button per model (nbp / gi2 / wan) — each enqueues that model on kie as its
// own variant, so clicking several fans out across models. The swap feeds only
// the character(s) WIRED to this frame (drag a character from the sidebar onto
// the frame to wire it), so a row of inline micro-thumbs shows exactly what
// Image 1/2/3(/4) resolve to. Frame 2 threads the prior frame-1 swap as
// continuity reference.
import { memo, useCallback, useMemo, useState } from 'react';
import { ImageOff, RotateCcw, UserRound, X } from 'lucide-react';
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
  frameUsesSource,
  type SwapModel,
  type SwapProvider,
} from '../charSwapModel';
import { FlipCard, FlipToggle, NodeFrame, StateThumb } from './nodeUi';
import { nodeImageHeight } from './nodeLayout';
import { RunButton } from './controls';
import { VariantStrip, VARIANT_STRIP_H } from './VariantStrip';
import { RichPromptField } from '@/components/ui/RichPromptField';
import type { ChipThumb } from '@/components/ui/AssetThumbChip';
import type { RichToken } from '@/components/ui/richPromptTokens';

const NODE_WIDTH = 520;
const CONTROLS_H = 250;
const THUMB_STRIP_H = 70;

// The provider/model selectors collapse to one direct "Run <model>" button per
// model. kie hosts all three models (fal only nbp/wan), so every button runs on
// kie and the provider toggle is gone — each click enqueues that model as its
// own variant. The JSON-flip preview uses the primary model as a representative.
const SWAP_PROVIDER: SwapProvider = 'kie';
const SWAP_MODELS = MODELS_BY_PROVIDER[SWAP_PROVIDER];
const PRIMARY_SWAP_MODEL: SwapModel = 'nano-banana-pro';

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
    <div className="group relative shrink-0" style={{ width: 48, height: 48 }} title={title}>
      {src ? (
        <img src={src} alt={title} className="w-full h-full object-cover rounded border border-zinc-700" />
      ) : (
        <div className="w-full h-full rounded border border-zinc-700 bg-black/50 flex items-center justify-center">
          <UserRound className="w-5 h-5 text-zinc-600" />
        </div>
      )}
      <span className="absolute -top-1 -left-1 min-w-[15px] h-3.5 px-0.5 rounded-sm bg-emerald-500/90 text-black text-[10px] font-mono font-bold leading-[14px] text-center">
        {n}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={removeTitle ?? 'Remove this input'}
          aria-label={removeTitle ?? 'Remove this input'}
          className={cn(
            'nodrag absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full',
            'border border-zinc-600 bg-zinc-900 text-zinc-300 leading-none',
            'hover:border-red-500 hover:bg-red-600 hover:text-white',
          )}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function SwapGenNodeImpl({ data }: { data: SwapGenNodeData }) {
  const { sidecar, mediaItems, projectSlug, sourceAspect, actions } = usePlanFlow();
  const { sceneIndex, frameIndex } = data;
  const scene = sidecar.scenes[sceneIndex];

  const [runningModels, setRunningModels] = useState<Set<SwapModel>>(new Set());
  const [dropActive, setDropActive] = useState(false);
  // Separate drop-highlight for the big swap tile (drop a ready image to use it
  // directly as the swap) vs the character thumb-strip below (wire a character).
  const [tileDropActive, setTileDropActive] = useState(false);
  // Single prompt override; falls back to the count-aware default so it always
  // reflects how many characters are wired (1 → "Image 2", 2 → "Image 2 and
  // Image 3"). Every "Run <model>" button sends this same prompt.
  const [override, setOverride] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);

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

  const prompt = override ?? defaultSwapPrompt(charCount, Boolean(priorSwapAssetId));
  const onPromptChange = useCallback((next: string) => { setOverride(next); }, []);

  const tile = scene ? deriveTileState(scene, frameIndex, mediaItems) : ({ kind: 'idle' } as const);
  const imageH = nodeImageHeight(NODE_WIDTH, sourceAspect, 300);
  // "Skip → use the original source frame as-is" state for this frame.
  const usesSource = frameUsesSource(scene, frameIndex);
  const sourceFrameUrl = scene
    ? `/files/${projectSlug}/plan/s${sceneIndex + 1}-image${frameIndex}-source.jpg?v=${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`
    : '';

  // Drop a ready image asset onto the tile to use it directly as this frame's
  // swap (bypassing generation). Same server path as picking a variant; the
  // server clears any "use source" flag when a real image is pointed at the frame.
  const onDropSwapImage = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTileDropActive(false);
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
    const item = mediaItems.find((m) => m.id === id);
    if (!item || (item.type !== 'image' && item.type !== 'character')) {
      toast({
        title: 'Drop an image',
        description: "Drag a ready image asset onto the frame to use it directly as this frame's swap.",
        duration: 4000,
      });
      return;
    }
    void actions.promoteVariant(sceneIndex, frameIndex, id);
  }, [mediaItems, actions, sceneIndex, frameIndex]);

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

  // Resolve the prompt's inline tokens to thumbs: "[Image N]" → the matching
  // token thumb (source/char/prior), "@slug" → any project asset.
  const assetSlugs = useMemo(() => mediaItems.map((m) => m.slug).filter(Boolean), [mediaItems]);
  const slugForAssetId = useCallback(
    (id: string) => mediaItems.find((m) => m.id === id)?.slug ?? null,
    [mediaItems],
  );
  const resolveRef = useCallback(
    (token: RichToken): ChipThumb | null => {
      if (token.kind === 'image-ref') {
        const t = tokenThumbs.find((x) => x.n === token.n);
        if (!t) return null;
        return { thumbnailSrc: t.src, type: t.kind === 'char' ? 'character' : 'image', label: t.title, badge: String(token.n) };
      }
      const item = mediaItems.find((m) => m.slug === token.slug);
      if (!item) return null;
      return {
        thumbnailSrc: item.thumbnailSrc ?? item.filePath ?? null,
        type: item.type === 'video' ? 'video' : 'image',
        label: item.slug,
      };
    },
    [tokenThumbs, mediaItems],
  );

  const payload = useMemo(
    () => buildSwapPayload(SWAP_PROVIDER, PRIMARY_SWAP_MODEL, wiredChars, sceneIndex, frameIndex, prompt, sourceAspect, priorSwapAssetId),
    [wiredChars, sceneIndex, frameIndex, prompt, sourceAspect, priorSwapAssetId],
  );

  // Each "Run <model>" button enqueues that model on kie as its own variant in
  // image{N}_variants. Want several models? Click several buttons — this replaces
  // the old single Run + provider/model selectors + "+also" fan-out.
  const runModel = useCallback((m: SwapModel) => {
    setRunningModels((prev) => new Set(prev).add(m));
    void (async () => {
      try {
        // Generating a swap means the frame is no longer skipped-to-source.
        if (usesSource) await actions.setFrameSource(sceneIndex, frameIndex, false);
        await actions.runSwap(sceneIndex, frameIndex, SWAP_PROVIDER, m, {
          customPrompt: prompt,
          ...(priorSwapAssetId ? { priorSwapAssetId } : {}),
        });
      } finally {
        setRunningModels((prev) => {
          const n = new Set(prev);
          n.delete(m);
          return n;
        });
      }
    })();
  }, [actions, sceneIndex, frameIndex, prompt, priorSwapAssetId, usesSource]);

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
    <div className="flex h-full flex-col">
      <div
        className={cn('shrink-0 rounded transition-shadow', tileDropActive && 'ring-2 ring-sky-400/70')}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setTileDropActive(true); }}
        onDragLeave={() => setTileDropActive(false)}
        onDrop={onDropSwapImage}
        title="Drop a ready image here to use it directly as this frame's swap"
      >
        {usesSource ? (
          <div className="relative w-full overflow-hidden rounded border border-sky-700/50 bg-black/60" style={{ height: imageH }}>
            <img src={sourceFrameUrl} alt={`${data.label} (source frame)`} className="h-full w-full object-cover" />
            <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-sky-200">
              using source frame
            </span>
            <button
              type="button"
              onClick={() => { void actions.setFrameSource(sceneIndex, frameIndex, false); }}
              title="Undo — generate a swap for this frame instead"
              className="nodrag absolute right-1.5 top-1.5 flex items-center gap-1 rounded border border-zinc-600 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-200"
            >
              <RotateCcw className="h-3 w-3" />
              undo
            </button>
          </div>
        ) : tile.kind === 'idle' ? (
          <div className="flex w-full flex-col items-center justify-center gap-2 rounded border border-dashed border-zinc-700 bg-black/60 px-3 text-center" style={{ height: imageH }}>
            <ImageOff className="h-5 w-5 text-zinc-600" />
            <span className="font-mono text-[11px] text-zinc-500">no swap yet</span>
            <span className="font-mono text-[10px] text-zinc-600">drop an image here to use it directly</span>
            <button
              type="button"
              onClick={() => { void actions.setFrameSource(sceneIndex, frameIndex, true); }}
              title="Skip the swap — use the original source frame as-is for the video"
              className="nodrag mt-0.5 rounded border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-sky-200 hover:bg-sky-500/20"
            >
              skip → use source frame
            </button>
          </div>
        ) : (
          <StateThumb tile={tile} heightPx={imageH} idleText="no swap yet" alt={data.label} />
        )}
      </div>
      {hasVariants && (
        <div className="shrink-0">
          <VariantStrip
            variants={variants}
            selectedAssetId={selectedAssetId}
            mediaItems={mediaItems}
            onPick={(assetId) => { void actions.promoteVariant(sceneIndex, frameIndex, assetId); }}
          />
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropActive(true); }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDropCharacter}
        title="Drag a character from the sidebar to wire it into this frame"
        className={cn(
          'mt-2.5 shrink-0 flex items-center gap-2.5 flex-wrap rounded p-1 -m-1 transition-colors',
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
          <span className="text-[11px] font-mono text-violet-300/60 leading-tight">
            1 char · drag a character from the sidebar to add
          </span>
        )}
        {canRestorePrior && (
          <button
            type="button"
            onClick={() => { void actions.setSkipPrior(sceneIndex, false); }}
            title="Restore the prior-frame continuity reference"
            className="nodrag text-[11px] font-mono text-amber-300/70 hover:text-amber-200 leading-tight underline decoration-dotted"
          >
            continuity off · restore
          </button>
        )}
      </div>
      <div className="mt-2.5 flex min-h-0 flex-1 flex-col gap-2.5">
        <RichPromptField
          value={prompt}
          onChange={onPromptChange}
          resolveRef={resolveRef}
          assetSlugs={assetSlugs}
          slugForAssetId={slugForAssetId}
          fill
          rows={6}
          fieldClassName="nodrag w-full px-2.5 py-2 text-[13px] font-mono leading-relaxed"
          surfaceClassName="nodrag rounded border border-zinc-700 bg-black/60 focus-within:border-emerald-500/60"
          textClassName="text-emerald-100/90"
          caretClassName="caret-emerald-300"
        />
        <div className="shrink-0 flex items-center justify-end gap-2 flex-wrap">
          {SWAP_MODELS.map((m) => (
            <RunButton
              key={m}
              size="lg"
              onClick={() => runModel(m)}
              running={runningModels.has(m)}
              label={`Run ${SHORT_LABEL_BY_MODEL[m]}`}
              title={`Run ${SHORT_LABEL_BY_MODEL[m]} as a variant (kie)`}
            />
          ))}
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
      size="lg"
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

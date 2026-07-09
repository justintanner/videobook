// Per-scene video gen (Seedance interpolation). Model selector, per-model
// prompt, gating mirroring SceneBlock, a Run wired to the shared
// useCharSwapActions, and a GUI↔JSON flip showing the derived KIE video payload
// with inline clip/audio/ref thumbnails.
import { memo, useCallback, useMemo, useState } from 'react';
import { RichPromptField } from '@/components/ui/RichPromptField';
import type { ChipThumb } from '@/components/ui/AssetThumbChip';
import type { RichToken } from '@/components/ui/richPromptTokens';
import { PayloadJsonView } from '@/components/center-stage/PlanViewer';
import { usePlanFlow } from '../PlanFlowContext';
import type { SceneVideoNodeData } from './nodeData';
import {
  ALL_VIDEO_MODELS,
  PLAN_ASSET_ID,
  buildKieVideoPayload,
  deriveTileState,
  deriveVideoTileState,
  rewriteVisualWithImageTokens,
  videoReadyForGen,
  type VideoModel,
} from '../charSwapModel';
import { FlipCard, FlipToggle, NodeFrame, StateThumb } from './nodeUi';
import { nodeImageHeight } from './nodeLayout';
import { RunButton, Segmented } from './controls';

// Sized to match the swap/source nodes above (one column wide). The fill prompt
// grows to push the Run button flush against the bottom.
const NODE_WIDTH = 520;
const CONTROLS_H = 200;

const SHORT_VIDEO_LABEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'sd2',
  'seedance-2-fast': 'sd2·f',
  'seedance-2-mini': 'sd2·m',
};
const VIDEO_OPTIONS = ALL_VIDEO_MODELS.map((m) => ({ value: m, label: SHORT_VIDEO_LABEL[m] }));

function SceneVideoNodeImpl({ data }: { data: SceneVideoNodeData }) {
  const { sidecar, characters, mediaItems, projectSlug, sourceAspect, actions } = usePlanFlow();
  const { sceneIndex } = data;
  const scene = sidecar.scenes[sceneIndex];

  const [model, setModel] = useState<VideoModel>('seedance-2-mini');
  const [flipped, setFlipped] = useState(false);
  const [prompts, setPrompts] = useState<Record<VideoModel, string>>(() => {
    const seed = scene ? rewriteVisualWithImageTokens(scene.visual, characters) : '';
    return { 'seedance-2-ref': seed, 'seedance-2-fast': seed, 'seedance-2-mini': seed };
  });

  const onPromptChange = useCallback((next: string) => {
    setPrompts((prev) => ({ ...prev, [model]: next }));
  }, [model]);

  // "@ImageN" / "Image N" → the Nth plan character; "@slug" → any project asset.
  const assetSlugs = useMemo(() => mediaItems.map((m) => m.slug).filter(Boolean), [mediaItems]);
  const slugForAssetId = useCallback(
    (id: string) => mediaItems.find((m) => m.id === id)?.slug ?? null,
    [mediaItems],
  );
  const resolveRef = useCallback(
    (token: RichToken): ChipThumb | null => {
      if (token.kind === 'image-ref') {
        const c = characters[token.n - 1];
        if (!c) return null;
        const item = mediaItems.find((m) => m.id === c.asset_id);
        return { thumbnailSrc: item?.thumbnailSrc ?? item?.filePath ?? null, type: 'character', label: c.name, badge: String(token.n) };
      }
      if (token.kind === 'character-ref') return null;
      const item = mediaItems.find((m) => m.slug === token.slug);
      if (!item) return null;
      return {
        thumbnailSrc: item.thumbnailSrc ?? item.filePath ?? null,
        type: item.type === 'video' ? 'video' : 'image',
        label: item.slug,
      };
    },
    [characters, mediaItems],
  );

  const imageH = nodeImageHeight(NODE_WIDTH, sourceAspect, 300);
  const running = actions.isVideoInFlight(sceneIndex);
  // Pass `running` so a not-yet-listed asset only spins while the submit is in
  // flight; a dangling scene.swap.video link (asset deleted / gen rolled back)
  // falls back to idle instead of spinning forever.
  const videoTile = scene ? deriveVideoTileState(scene, mediaItems, projectSlug, running) : ({ kind: 'idle' } as const);

  const gate = useMemo(() => {
    if (!scene) return { ok: false, reason: 'no scene' };
    const tile1 = deriveTileState(scene, 1, mediaItems);
    const tile2 = deriveTileState(scene, 2, mediaItems);
    return videoReadyForGen(scene, tile1, tile2);
  }, [scene, mediaItems]);

  const payload = useMemo(() => {
    if (!scene) return null;
    const clipSlug = scene.clip_filename ? `${PLAN_ASSET_ID}/${scene.clip_filename}` : null;
    const audioSlug = scene.audio_filename ? `${PLAN_ASSET_ID}/${scene.audio_filename}` : null;
    return buildKieVideoPayload(model, scene, sceneIndex, characters, mediaItems, clipSlug, audioSlug, prompts[model], sourceAspect);
  }, [scene, sceneIndex, model, characters, mediaItems, prompts, sourceAspect]);

  const run = useCallback(() => {
    void actions.runVideo(sceneIndex, model, prompts[model]);
  }, [actions, sceneIndex, model, prompts]);

  if (!scene) return null;

  const front = (
    <div className="flex h-full flex-col">
      <div className="shrink-0">
        {videoTile.kind === 'ready' ? (
          <video
            src={videoTile.src}
            muted
            loop
            playsInline
            className="w-full rounded bg-black/60 border border-zinc-800 object-cover"
            style={{ height: imageH }}
            onMouseEnter={(e) => { void e.currentTarget.play().catch(() => {}); }}
            onMouseLeave={(e) => { e.currentTarget.pause(); }}
          />
        ) : (
          <StateThumb tile={videoTile} heightPx={imageH} idleText="no video yet" alt={data.label} />
        )}
      </div>
      <div className="mt-2.5 flex min-h-0 flex-1 flex-col gap-2.5">
        <Segmented options={VIDEO_OPTIONS} value={model} onChange={setModel} ariaLabel="video model" size="lg" />
        <RichPromptField
          value={prompts[model]}
          onChange={onPromptChange}
          resolveRef={resolveRef}
          assetSlugs={assetSlugs}
          slugForAssetId={slugForAssetId}
          fill
          rows={4}
          fieldClassName="nodrag w-full px-2.5 py-2 text-[13px] font-mono leading-relaxed"
          surfaceClassName="nodrag rounded border border-zinc-700 bg-black/60 focus-within:border-sky-500/60"
          textClassName="text-sky-100/90"
          caretClassName="caret-sky-300"
        />
        <div className="shrink-0 flex items-center justify-between gap-2">
          <span className="text-[11px] font-mono text-zinc-500 truncate">
            {gate.ok ? '720p · ready' : (gate.reason ?? '')}
          </span>
          <RunButton size="lg" onClick={run} running={running} disabled={!gate.ok} label="Run video" title={gate.reason} />
        </div>
      </div>
    </div>
  );

  return (
    <NodeFrame
      label={data.label}
      accent="border-sky-600/50"
      width={NODE_WIDTH}
      size="lg"
      badge={<FlipToggle flipped={flipped} onToggle={() => setFlipped((f) => !f)} />}
    >
      <FlipCard
        flipped={flipped}
        height={imageH + CONTROLS_H}
        front={front}
        back={<PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />}
      />
    </NodeFrame>
  );
}

export const SceneVideoNode = memo(SceneVideoNodeImpl);

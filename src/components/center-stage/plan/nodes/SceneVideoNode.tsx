// Per-scene video gen (Seedance interpolation / Grok i2v). Model selector,
// per-model prompt (Grok seeds with the scene's dialog), gating mirroring
// SceneBlock, a Run wired to the shared useCharSwapActions, and a GUI↔JSON flip
// showing the derived KIE video payload with inline clip/audio/ref thumbnails.
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
  grokVideoReadyForGen,
  rewriteVisualWithImageTokens,
  videoReadyForGen,
  type VideoModel,
} from '../charSwapModel';
import { FlipCard, FlipToggle, NodeFrame, StateThumb } from './nodeUi';
import { nodeImageHeight } from './nodeLayout';
import { RunButton, Segmented } from './controls';

const NODE_WIDTH = 280;
const CONTROLS_H = 112;

const SHORT_VIDEO_LABEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'sd2',
  'seedance-2-fast': 'sd2·f',
  'grok-imagine-1-5': 'grok',
};
const VIDEO_OPTIONS = ALL_VIDEO_MODELS.map((m) => ({ value: m, label: SHORT_VIDEO_LABEL[m] }));

function SceneVideoNodeImpl({ data }: { data: SceneVideoNodeData }) {
  const { sidecar, characters, mediaItems, projectSlug, sourceAspect, actions } = usePlanFlow();
  const { sceneIndex } = data;
  const scene = sidecar.scenes[sceneIndex];

  const [model, setModel] = useState<VideoModel>('seedance-2-ref');
  const [flipped, setFlipped] = useState(false);
  const [prompts, setPrompts] = useState<Record<VideoModel, string>>(() => {
    const seed = scene ? rewriteVisualWithImageTokens(scene.visual, characters) : '';
    const dialog = (scene?.dialog ?? '').trim();
    const grokSeed = dialog.length > 0 && dialog !== '(no speech in this chunk)' ? `${seed}\n\nDialogue: ${dialog}` : seed;
    return { 'seedance-2-ref': seed, 'seedance-2-fast': seed, 'grok-imagine-1-5': grokSeed };
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

  const imageH = nodeImageHeight(NODE_WIDTH, sourceAspect);
  const videoTile = scene ? deriveVideoTileState(scene, mediaItems, projectSlug) : ({ kind: 'idle' } as const);

  const gate = useMemo(() => {
    if (!scene) return { ok: false, reason: 'no scene' };
    const tile1 = deriveTileState(scene, 1, mediaItems);
    const tile2 = deriveTileState(scene, 2, mediaItems);
    return model === 'grok-imagine-1-5' ? grokVideoReadyForGen(scene, tile1) : videoReadyForGen(scene, tile1, tile2);
  }, [scene, mediaItems, model]);

  const payload = useMemo(() => {
    if (!scene) return null;
    const clipSlug = scene.clip_filename ? `${PLAN_ASSET_ID}/${scene.clip_filename}` : null;
    const audioSlug = scene.audio_filename ? `${PLAN_ASSET_ID}/${scene.audio_filename}` : null;
    return buildKieVideoPayload(model, scene, characters, mediaItems, clipSlug, audioSlug, prompts[model], sourceAspect);
  }, [scene, model, characters, mediaItems, prompts, sourceAspect]);

  const running = actions.isVideoInFlight(sceneIndex);
  const run = useCallback(() => {
    void actions.runVideo(sceneIndex, model, prompts[model]);
  }, [actions, sceneIndex, model, prompts]);

  if (!scene) return null;

  const front = (
    <div>
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
      <div className="mt-2 flex flex-col gap-1.5">
        <Segmented options={VIDEO_OPTIONS} value={model} onChange={setModel} ariaLabel="video model" />
        <RichPromptField
          value={prompts[model]}
          onChange={onPromptChange}
          resolveRef={resolveRef}
          assetSlugs={assetSlugs}
          slugForAssetId={slugForAssetId}
          rows={2}
          fieldClassName="nodrag w-full px-1.5 py-1 text-[10px] font-mono leading-snug"
          surfaceClassName="nodrag rounded border border-zinc-700 bg-black/60 focus-within:border-sky-500/60"
          textClassName="text-sky-100/90"
          caretClassName="caret-sky-300"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] font-mono text-zinc-500 truncate">
            {gate.ok ? '720p · ready' : (gate.reason ?? '')}
          </span>
          <RunButton onClick={run} running={running} disabled={!gate.ok} label="Run video" title={gate.reason} />
        </div>
      </div>
    </div>
  );

  return (
    <NodeFrame
      label={data.label}
      accent="border-sky-600/50"
      width={NODE_WIDTH}
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

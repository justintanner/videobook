import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Film, Loader2, MapPin, X, FileText, Code, Copy, Check, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { useMountKey } from '@/contexts/MountKeyContext';
import { ViewerToolbar } from './viewer-shared';
import { uploadProjectFile } from '@/lib/upload';

interface PlanScene {
  start: number;
  end: number;
  visual: string;
  swap?: {
    image1: string | null;
    image2: string | null;
    image1_accepted?: boolean;
    image2_accepted?: boolean;
    image1_variants?: Record<string, string>;
    image2_variants?: Record<string, string>;
  } | null;
}

interface PlanSidecar {
  scenes: PlanScene[];
  total_duration_s: number;
  max_scene_seconds: number;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  model: string;
}

function formatTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

interface PlanViewerProps {
  item: MediaItem | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}

export function PlanViewer({ item, mediaItems, projectSlug, callTool, onClose }: PlanViewerProps) {
  useMountKey('viewer');
  return (
    <PlanBody
      item={item}
      mediaItems={mediaItems}
      projectSlug={projectSlug}
      callTool={callTool}
      onClose={onClose}
    />
  );
}

function PlanShell({ title, slug, onClose, children }: {
  title: string;
  slug: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div className="w-full h-full relative">
        <div className="absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
          <ViewerToolbar
            left={
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-primary/90 drop-shadow-[0_0_4px_rgba(0,255,255,0.5)]">
                <MapPin className="w-3.5 h-3.5" />
                <span>{title}</span>
              </span>
            }
            slug={slug}
            right={
              <button
                tabIndex={-1}
                onClick={onClose}
                title="Close"
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
              >
                <X className="w-4 h-4 stroke-[2.5]" />
              </button>
            }
          />
          <div className="flex-1 bg-black flex flex-col min-h-0 relative">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

const SCENE_SECONDS = 7;

function PlanBody({ item, mediaItems, projectSlug, callTool, onClose }: {
  item: MediaItem | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}) {
  const { dispatch } = useCommandDispatch();
  const [sidecar, setSidecar] = useState<PlanSidecar | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [pendingCharA, setPendingCharA] = useState<string | null>(null);
  const [pendingCharB, setPendingCharB] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const cancelledRef = useRef(false);

  // Load read_plan on mount / when the plan asset changes. A read failure here
  // means "no plan yet" — we keep sidecar=null and the slot UI takes over.
  useEffect(() => {
    if (!projectSlug) return;
    cancelledRef.current = false;
    void (async () => {
      const result = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelledRef.current) return;
      if (result.isError) {
        setSidecar(null);
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed: PlanSidecar = JSON.parse(text);
        setSidecar(parsed);
        setPendingSource(null);
        setPendingCharA(null);
        setPendingCharB(null);
      } catch {
        setSidecar(null);
      }
    })();
    return () => { cancelledRef.current = true; };
  }, [callTool, projectSlug, item?.id, item?.prompt]);

  // Effective slot values: pending wins, else fall back to sidecar.
  const sourceId = pendingSource ?? sidecar?.source_asset_id ?? null;
  const charAId = pendingCharA ?? sidecar?.characters[0]?.asset_id ?? null;
  const charBId = pendingCharB ?? sidecar?.characters[1]?.asset_id ?? null;

  const sourceItem = useMemo(
    () => (sourceId ? mediaItems.find((m) => m.id === sourceId) ?? null : null),
    [sourceId, mediaItems],
  );
  const duration = sourceItem?.duration ?? null;
  const scenesCount = duration && duration > 0
    ? Math.max(1, Math.ceil(duration / SCENE_SECONDS))
    : null;

  const slotsDifferFromSidecar = sidecar
    ? sidecar.source_asset_id !== sourceId
      || (sidecar.characters[0]?.asset_id ?? null) !== charAId
      || (sidecar.characters[1]?.asset_id ?? null) !== charBId
    : true;

  const canGenerate =
    Boolean(sourceId && charAId && charBId)
    && charAId !== charBId
    && slotsDifferFromSidecar;

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !sourceId || !charAId || !charBId) return;
    setGenerating(true);
    try {
      const result = await callTool('plan_visualization', {
        source_asset_id: sourceId,
        project_slug: projectSlug,
        character_asset_ids: [charAId, charBId],
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Failed to generate plan';
        toast({ title: 'Plan generation failed', description: msg, duration: 5000 });
        return;
      }
      await callTool('sync', { project_slug: projectSlug });
      const planResult = await callTool('read_plan', { project_slug: projectSlug });
      if (!planResult.isError) {
        try {
          const text = (planResult.content as Array<{ type: string; text: string }>)[0].text;
          const parsed: PlanSidecar = JSON.parse(text);
          setSidecar(parsed);
          setPendingSource(null);
          setPendingCharA(null);
          setPendingCharB(null);
        } catch {
          // Sidecar will refresh on next mount.
        }
      }
      toast({ title: 'Plan generated', description: `${scenesCount ?? '?'} scenes`, duration: 2500 });
    } finally {
      setGenerating(false);
    }
  }, [canGenerate, sourceId, charAId, charBId, projectSlug, callTool, scenesCount]);

  const slug = sidecar ? (item?.slug ?? 'plan') : 'plan (not yet generated)';

  return (
    <PlanShell title="PLAN: CHAR SWAP" slug={slug} onClose={onClose}>
      <div className="flex-1 overflow-y-auto scrollbar-cyan">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <PlanHeader
            sourceId={sourceId}
            charAId={charAId}
            charBId={charBId}
            mediaItems={mediaItems}
            duration={duration}
            scenesCount={scenesCount}
            canGenerate={canGenerate}
            generating={generating}
            onSourceDrop={setPendingSource}
            onCharADrop={setPendingCharA}
            onCharBDrop={setPendingCharB}
            onGenerate={() => { void handleGenerate(); }}
          />
          {sidecar && (
            <PlanScenes
              data={sidecar}
              mediaItems={mediaItems}
              projectSlug={projectSlug}
              callTool={callTool}
              dispatch={dispatch}
              onSidecarUpdate={setSidecar}
            />
          )}
        </div>
      </div>
    </PlanShell>
  );
}

type SwapModel = 'nano-banana-pro' | 'gpt-image-2' | 'wan-2-7-image-pro';

const ALL_SWAP_MODELS: SwapModel[] = ['nano-banana-pro', 'gpt-image-2', 'wan-2-7-image-pro'];

const SHORT_LABEL_BY_MODEL: Record<SwapModel, string> = {
  'nano-banana-pro': 'nbp',
  'gpt-image-2': 'gpt',
  'wan-2-7-image-pro': 'wan',
};

type VideoModel = 'seedance-2-ref' | 'seedance-2-fast';

const ALL_VIDEO_MODELS: VideoModel[] = ['seedance-2-ref', 'seedance-2-fast'];

const TOOL_BY_VIDEO_MODEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'generate_seedance2_video',
  'seedance-2-fast': 'generate_seedance2_fast_video',
};

// Convention from extract-audio.ts: deriveAudioName(vid-X) = ext-X → asset id `aud-ext-X`.
function sourceAudioAssetId(sourceVideoAssetId: string): string {
  const base = sourceVideoAssetId.startsWith('vid-')
    ? sourceVideoAssetId.slice(4)
    : sourceVideoAssetId;
  return `aud-ext-${base}`;
}

function PlanScenes({ data, mediaItems, projectSlug, callTool, dispatch, onSidecarUpdate }: {
  data: PlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  dispatch: (input: string) => Promise<boolean>;
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}) {
  // Kick off audio extraction once per (project, source) — the VIDEO button
  // needs `aud-ext-${base}` to splice onto the silent r2v output. Skipped if
  // the asset is already present.
  //
  // We deliberately wait until mediaItems has loaded (any item from this
  // project's sidebar would do) before deciding. Firing while the sidebar is
  // still empty would create a duplicate `aud-ext-*-2` whenever extraction
  // had previously run.
  const audioBootstrapKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${projectSlug}/${data.source_asset_id}`;
    if (audioBootstrapKeyRef.current === key) return;
    if (mediaItems.length === 0) return; // Sidebar not loaded yet — defer.
    const expected = sourceAudioAssetId(data.source_asset_id);
    if (mediaItems.some((m) => m.id === expected)) {
      audioBootstrapKeyRef.current = key;
      return;
    }
    audioBootstrapKeyRef.current = key;
    void (async () => {
      const result = await callTool('extract_audio', {
        project_slug: projectSlug,
        asset_id: data.source_asset_id,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'extract_audio failed';
        toast({ title: 'Source audio extract failed', description: msg, duration: 5000 });
      }
    })();
  }, [projectSlug, data.source_asset_id, mediaItems, callTool]);

  return (
    <div className="space-y-5">
      {data.scenes.map((scene, idx) => (
        <SceneBlock
          key={`${scene.start}-${scene.end}-${idx}`}
          scene={scene}
          index={idx}
          characters={data.characters}
          sourceVideoAssetId={data.source_asset_id}
          mediaItems={mediaItems}
          projectSlug={projectSlug}
          callTool={callTool}
          dispatch={dispatch}
          onSidecarUpdate={onSidecarUpdate}
        />
      ))}
    </div>
  );
}

type FrameTileState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; src: string; accepted: boolean }
  | { kind: 'error'; message: string };

type ReplaceSource =
  | { kind: 'file'; file: File }
  | { kind: 'asset'; assetId: string };

interface SidebarDragPayload {
  slug?: string;
  id?: string;
  type?: string;
}

function deriveTileState(
  scene: PlanScene,
  frameIndex: 1 | 2,
  mediaItems: MediaItem[],
): FrameTileState {
  const swapId = scene.swap?.[`image${frameIndex}` as 'image1' | 'image2'];
  if (!swapId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === swapId);
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') {
    return { kind: 'error', message: item.failedMessage ?? 'swap failed' };
  }
  if (item.status === 'ready') {
    const src = item.thumbnailSrc ?? item.filePath ?? null;
    const accepted = scene.swap?.[`image${frameIndex}_accepted` as 'image1_accepted' | 'image2_accepted'] === true;
    if (src) return { kind: 'ready', src, accepted };
    return { kind: 'generating' };
  }
  return { kind: 'generating' };
}

// Extract the short model code from an auto-generated swap slug like
// `img-scene-0-image2-nbp-swap`. Returns null for manual-upload assets etc.
function modelCodeFromSwapAssetId(assetId: string | null | undefined): string | null {
  if (!assetId) return null;
  const m = /-image\d+-(nbp|gpt|wan)-swap/.exec(assetId);
  return m ? m[1] : null;
}

function SceneFrameRows({ sceneIndex, scene, projectSlug, mediaItems, inFlightModels1, inFlightModels2, accepting, replacing, onAccept, onReplace, onIdleClick, onErrorRetry }: {
  sceneIndex: number;
  scene: PlanScene;
  projectSlug: string;
  mediaItems: MediaItem[];
  inFlightModels1: SwapModel[];
  inFlightModels2: SwapModel[];
  accepting: Set<1 | 2>;
  replacing: Set<1 | 2>;
  onAccept: (frameIndex: 1 | 2) => void;
  onReplace: (frameIndex: 1 | 2, source: ReplaceSource) => void;
  onIdleClick: () => void;
  onErrorRetry: (frameIndex: 1 | 2) => void;
}) {
  // Cache-bust the source-frame thumbnails on scene-boundary changes — when
  // /plan-vis re-runs and produces different chunks, timestamps shift and the
  // same filename now points at a different frame.
  const v = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;
  const sourceUrl = (i: 1 | 2) =>
    `/files/${projectSlug}/plan/scene-${sceneIndex}-image${i}-source.jpg?v=${v}`;
  return (
    <div className="flex flex-wrap gap-6 px-3 py-3 border-b border-zinc-800/40 bg-black/20">
      <SourceSlotPair
        frameIndex={1}
        sourceSrc={sourceUrl(1)}
        state={deriveTileState(scene, 1, mediaItems)}
        inFlightModels={inFlightModels1}
        currentModelCode={modelCodeFromSwapAssetId(scene.swap?.image1)}
        label={`image1 · first ${formatTimecode(scene.start)}`}
        accepting={accepting.has(1)}
        replacing={replacing.has(1)}
        onAccept={() => onAccept(1)}
        onReplace={(source) => onReplace(1, source)}
        onIdleClick={onIdleClick}
        onErrorRetry={() => onErrorRetry(1)}
      />
      <SourceSlotPair
        frameIndex={2}
        sourceSrc={sourceUrl(2)}
        state={deriveTileState(scene, 2, mediaItems)}
        inFlightModels={inFlightModels2}
        currentModelCode={modelCodeFromSwapAssetId(scene.swap?.image2)}
        label={`image2 · last ${formatTimecode(scene.end)}`}
        accepting={accepting.has(2)}
        replacing={replacing.has(2)}
        onAccept={() => onAccept(2)}
        onReplace={(source) => onReplace(2, source)}
        onIdleClick={onIdleClick}
        onErrorRetry={() => onErrorRetry(2)}
      />
    </div>
  );
}

function SourceSlotPair({ frameIndex, sourceSrc, state, inFlightModels, currentModelCode, label, accepting, replacing, onAccept, onReplace, onIdleClick, onErrorRetry }: {
  frameIndex: 1 | 2;
  sourceSrc: string;
  state: FrameTileState;
  inFlightModels: SwapModel[];
  currentModelCode: string | null;
  label: string;
  accepting: boolean;
  replacing: boolean;
  onAccept: () => void;
  onReplace: (source: ReplaceSource) => void;
  onIdleClick: () => void;
  onErrorRetry?: () => void;
}) {
  void frameIndex;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <SourceThumb src={sourceSrc} alt={`source ${label}`} />
        <SwapSlot
          state={state}
          sourceSrc={sourceSrc}
          inFlightModels={inFlightModels}
          currentModelCode={currentModelCode}
          accepting={accepting}
          replacing={replacing}
          onAccept={onAccept}
          onReplace={onReplace}
          onIdleClick={onIdleClick}
          onErrorRetry={onErrorRetry}
        />
      </div>
      <div className="text-[10px] font-mono text-primary/50">{label}</div>
    </div>
  );
}

function SourceThumb({ src, alt }: { src: string; alt: string }) {
  const [errored, setErrored] = useState(false);
  return (
    <div className="w-40 aspect-video bg-zinc-900 border border-zinc-700/40 rounded overflow-hidden flex items-center justify-center">
      {errored ? (
        <span className="text-[9px] font-mono text-primary/30 px-2 text-center">missing</span>
      ) : (
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-cover opacity-80"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

function SwapSlot({ state, sourceSrc, inFlightModels, currentModelCode, accepting, replacing, onAccept, onReplace, onIdleClick, onErrorRetry }: {
  state: FrameTileState;
  sourceSrc: string;
  inFlightModels: SwapModel[];
  currentModelCode: string | null;
  accepting: boolean;
  replacing: boolean;
  onAccept: () => void;
  onReplace: (source: ReplaceSource) => void;
  onIdleClick: () => void;
  onErrorRetry?: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const anyInFlight = inFlightModels.length > 0;
  const showSpinner = state.kind === 'generating' || replacing || (anyInFlight && state.kind === 'idle');
  // Caption inside the spinner overlay so the user knows what's running.
  // Prefers the currently-selected slot's model (whose asset is in
  // 'generating' status) and otherwise lists any in-flight model submissions.
  const spinnerLabel = (() => {
    if (replacing) return 'uploading…';
    if (state.kind === 'generating' && currentModelCode) {
      return `${currentModelCode}…`;
    }
    if (inFlightModels.length > 0) {
      return inFlightModels.map((m) => SHORT_LABEL_BY_MODEL[m]).join(', ');
    }
    return null;
  })();
  const showReadyActions = state.kind === 'ready' && !state.accepted && !accepting && !replacing;
  const showAcceptedBadge = state.kind === 'ready' && state.accepted && !accepting && !replacing;
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (json) {
      try {
        const payload = JSON.parse(json) as SidebarDragPayload;
        const assetId = payload.id;
        if (typeof assetId === 'string' && assetId.startsWith('img-')) {
          onReplace({ kind: 'asset', assetId });
          return;
        }
        if (typeof assetId === 'string') {
          toast({ title: 'Not an image asset', description: `${assetId} is not an img-* asset.`, duration: 3000 });
          return;
        }
      } catch {
        // Malformed payload — fall through to file-drop branch.
      }
    }
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Not an image', description: `Got ${file.type || 'unknown'}; drop a PNG/JPG/WEBP.`, duration: 3000 });
      return;
    }
    onReplace({ kind: 'file', file });
  };
  return (
    <div
      className={cn(
        'relative w-40 aspect-video bg-zinc-900 border rounded overflow-hidden flex items-center justify-center group transition-colors',
        dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
      )}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={handleDrop}
    >
      {state.kind === 'ready' ? (
        <img src={state.src} alt="swap result" className="w-full h-full object-cover" loading="lazy" />
      ) : state.kind === 'idle' && !anyInFlight ? (
        <button
          type="button"
          onClick={onIdleClick}
          title="Click to pick models and generate · or drop an image"
          className="w-full h-full flex items-center justify-center hover:bg-primary/5 transition-colors cursor-pointer"
        >
          <span className="text-[10px] font-mono text-primary/40 group-hover:text-primary/70 px-2 text-center">click to generate · or drop image</span>
        </button>
      ) : !errored ? (
        <img
          src={sourceSrc}
          alt="working"
          className="w-full h-full object-cover opacity-40"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : (
        <span className="text-[10px] font-mono text-primary/40 px-2 text-center">missing</span>
      )}
      {showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60">
          <Loader2 className="w-5 h-5 animate-spin text-primary/80" />
          {spinnerLabel && (
            <span className="text-[9px] font-mono uppercase tracking-wider text-primary/70 px-2 text-center line-clamp-2">
              {spinnerLabel}
            </span>
          )}
        </div>
      )}
      {state.kind === 'error' && !showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-red-950/70 px-1.5">
          <span className="text-[9px] font-mono text-red-200/90 text-center line-clamp-2">
            {state.message}
          </span>
          {onErrorRetry && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onErrorRetry(); }}
              title="Retry with a tamer prompt that avoids moderation triggers"
              className={cn(
                'h-5 px-1.5 flex items-center gap-1 rounded',
                'text-[9px] font-mono uppercase tracking-wider',
                'text-red-50 hover:text-white',
                'bg-red-500/30 hover:bg-red-500/50 border border-red-300/50 hover:border-red-200/80',
              )}
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Retry
            </button>
          )}
        </div>
      )}
      {showReadyActions && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 px-1.5 py-1 bg-gradient-to-t from-black/90 via-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onAccept}
            title="Accept this swap"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-emerald-100 hover:text-white',
              'bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 hover:border-emerald-300/70',
            )}
          >
            <Check className="w-3 h-3" />
            Accept
          </button>
        </div>
      )}
      {showAcceptedBadge && (
        <div
          className="absolute top-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/30 border border-emerald-300/60 text-[9px] font-mono uppercase tracking-wider text-emerald-50"
          title="Accepted"
        >
          <Check className="w-2.5 h-2.5" />
          Accepted
        </div>
      )}
      {dragActive && !replacing && (
        <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/30 pointer-events-none">
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-50 font-bold">drop to replace</span>
        </div>
      )}
    </div>
  );
}

const DEFAULT_PROMPT_BY_SWAP_MODEL: Record<SwapModel, string> = {
  'nano-banana-pro': "Photorealistic edit. Replace Image 1's people with Image 2 and Image 3 references, preserving each one's identity and clothing. Keep the original composition, framing, lighting, and camera angle exactly as in Image 1.",
  'gpt-image-2': "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.",
  'wan-2-7-image-pro': "Replace each person in Image 1 with the matching reference from Image 2 and Image 3. Match facial identity, hair, and outfit precisely. Preserve Image 1's pose, composition, lighting, and camera angle.",
};

// Mirrors what server/src/payload-builders.ts produces for the corresponding
// `generate_*_image` tools, but in slug form (no URL resolution). Keep aligned
// with the swap-plan-scene-frame queue payload (always 16:9 / 2K) and the
// per-model `input` shapes from @apicity/kie's model-schemas.
const KIE_MODEL_NAME_BY_SWAP: Record<SwapModel, string> = {
  'nano-banana-pro': 'nano-banana-pro',
  'gpt-image-2': 'gpt-image-2-image-to-image',
  'wan-2-7-image-pro': 'wan/2-7-image-pro',
};

function buildKieImagePayload(
  model: SwapModel,
  characters: PlanSidecar['characters'],
  sceneIndex: number,
  frameIndex: 1 | 2,
  customPrompt: string,
  priorSwapAssetId?: string,
): { model: string; input: Record<string, unknown> } {
  const sourceFrameSlug = `@plan/scene-${sceneIndex}-image${frameIndex}-source.jpg`;
  const inputs = [
    sourceFrameSlug,
    ...characters.map((c) => `@${c.asset_id}`),
    ...(priorSwapAssetId ? [`@${priorSwapAssetId}`] : []),
  ];
  const trimmed = customPrompt.trim();
  const prompt = trimmed.length > 0 ? trimmed : DEFAULT_PROMPT_BY_SWAP_MODEL[model];
  const inputKey = model === 'nano-banana-pro' ? 'image_input' : 'input_urls';
  return {
    model: KIE_MODEL_NAME_BY_SWAP[model],
    input: {
      prompt,
      [inputKey]: inputs,
      aspect_ratio: '16:9',
      resolution: '2K',
    },
  };
}

function ImagePanel({ selectedModel, onSelectModel, prompt, onPromptChange, payload, mediaItems, projectSlug }: {
  selectedModel: SwapModel;
  onSelectModel: (model: SwapModel) => void;
  prompt: string;
  onPromptChange: (next: string) => void;
  payload: unknown;
  mediaItems: MediaItem[];
  projectSlug: string;
}) {
  const [view, setView] = useState<'prompt' | 'json'>('prompt');
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard permission failures
    }
  }, [payload]);
  return (
    <div className="px-3 py-3 border-b border-zinc-800/40 bg-black/30 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60">
        <div className="flex">
          <TabButton active={view === 'prompt'} onClick={() => setView('prompt')} icon={<FileText className="w-3 h-3" />}>
            Prompt
          </TabButton>
          <TabButton active={view === 'json'} onClick={() => setView('json')} icon={<Code className="w-3 h-3" />}>
            JSON
          </TabButton>
        </div>
        {view === 'json' && (
          <button
            type="button"
            onClick={handleCopy}
            title="Copy JSON payload"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-primary/70 hover:text-primary',
              'bg-primary/5 hover:bg-primary/10 border border-primary/20 hover:border-primary/40',
              'transition-colors duration-150',
            )}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <div className="flex items-center gap-x-2">
        {ALL_SWAP_MODELS.map((m) => (
          <TabButton
            key={m}
            active={selectedModel === m}
            onClick={() => onSelectModel(m)}
            icon={null}
          >
            {m}
          </TabButton>
        ))}
      </div>
      {view === 'prompt' ? (
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={4}
          className={cn(
            'w-full p-2 rounded bg-black/60 border border-zinc-700 text-[11px] font-mono text-primary/90 resize-y',
            'focus:outline-none focus:border-primary/60',
            'placeholder:text-primary/70',
          )}
        />
      ) : (
        <PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />
      )}
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteVisualWithImageTokens(
  visual: string,
  characters: PlanSidecar['characters'],
): string {
  let result = visual;
  characters.forEach((c, i) => {
    const re = new RegExp(`@${escapeRegExp(c.asset_id)}\\b`, 'g');
    result = result.replace(re, `@Image${i + 1}`);
  });
  return result;
}

function videoReadyForGen(scene: PlanScene): { ok: boolean; reason?: string } {
  const swap = scene.swap;
  const hasAny = !!(swap?.image1 || swap?.image2);
  if (!hasAny) return { ok: true };
  const accepted1 = swap?.image1_accepted === true;
  const accepted2 = swap?.image2_accepted === true;
  if (accepted1 && accepted2) return { ok: true };
  if (!accepted1 && !accepted2) return { ok: false, reason: 'Accept both swap frames first' };
  return { ok: false, reason: `Accept image${accepted1 ? '2' : '1'} swap first` };
}

function readySwapAssetIds(
  scene: PlanScene,
  mediaItems: MediaItem[],
): [string, string] | null {
  const a = scene.swap?.image1;
  const b = scene.swap?.image2;
  if (!a || !b) return null;
  const itemA = mediaItems.find((m) => m.id === a);
  const itemB = mediaItems.find((m) => m.id === b);
  if (itemA?.status !== 'ready' || itemB?.status !== 'ready') return null;
  return [a, b];
}

const KIE_MODEL_NAME_BY_VIDEO: Record<VideoModel, string> = {
  'seedance-2-ref': 'bytedance/seedance-2',
  'seedance-2-fast': 'bytedance/seedance-2-fast',
};

function buildKieVideoPayload(
  videoModel: VideoModel,
  scene: PlanScene,
  characters: PlanSidecar['characters'],
  mediaItems: MediaItem[],
  sourceVideoAssetId: string,
  customPrompt: string,
): { model: string; input: Record<string, unknown> } {
  const swapped = readySwapAssetIds(scene, mediaItems);
  const referenceImages = swapped
    ? swapped.map((id) => `@${id}`)
    : characters.map((c) => `@${c.asset_id}`);
  const trimmed = customPrompt.trim();
  const prompt = trimmed.length > 0
    ? trimmed
    : rewriteVisualWithImageTokens(scene.visual, characters);
  const duration = Math.min(15, Math.max(4, Math.round(scene.end - scene.start)));
  return {
    model: KIE_MODEL_NAME_BY_VIDEO[videoModel],
    input: {
      prompt,
      reference_image_urls: referenceImages,
      reference_video_urls: [`@${sourceVideoAssetId}`],
      reference_audio_urls: [`@${sourceAudioAssetId(sourceVideoAssetId)}`],
      resolution: '720p',
      aspect_ratio: '16:9',
      duration,
      generate_audio: false,
    },
  };
}

// Build the args for the actual generate_seedance2_video / _fast_video MCP
// tool call. This is what handleVideo dispatches; the JSON view shows the
// derived KIE REST shape via buildKieVideoPayload above.
function buildSeedanceToolArgs(
  scene: PlanScene,
  characters: PlanSidecar['characters'],
  mediaItems: MediaItem[],
  sourceVideoAssetId: string,
  customPrompt: string,
): Record<string, unknown> {
  const swapped = readySwapAssetIds(scene, mediaItems);
  const imageSlugs = swapped
    ? swapped.map((id) => `@${id}`)
    : characters.map((c) => `@${c.asset_id}`);
  const trimmed = customPrompt.trim();
  return {
    prompt: trimmed.length > 0 ? trimmed : rewriteVisualWithImageTokens(scene.visual, characters),
    image_slugs: imageSlugs,
    video_slugs: [`@${sourceVideoAssetId}`],
    audio_slugs: [`@${sourceAudioAssetId(sourceVideoAssetId)}`],
    resolution: '720p',
    aspect_ratio: '16:9',
    duration: String(Math.min(15, Math.max(4, Math.round(scene.end - scene.start)))),
    generate_audio: false,
  };
}

function SceneBlock({ scene, index, characters, sourceVideoAssetId, mediaItems, projectSlug, callTool, dispatch, onSidecarUpdate }: {
  scene: PlanScene;
  index: number;
  characters: PlanSidecar['characters'];
  mediaItems: MediaItem[];
  projectSlug: string;
  sourceVideoAssetId: string;
  callTool: UseMcpResult['callTool'];
  dispatch: (input: string) => Promise<boolean>;
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}) {
  void dispatch;
  const [submittingVideo, setSubmittingVideo] = useState(false);
  // In-flight tags: `${model}-${frameIndex}` — a single model+frame can be
  // mid-flight while others run in parallel.
  const [swapsInFlight, setSwapsInFlight] = useState<Set<string>>(new Set());
  const [accepting, setAccepting] = useState<Set<1 | 2>>(new Set());
  const [replacing, setReplacing] = useState<Set<1 | 2>>(new Set());
  // IMAGE panel state — per-model prompt overrides (per scene). The model
  // selector switches which model's prompt the textarea/JSON view targets;
  // every idle-thumb click still fans out to all three models in parallel,
  // each carrying its own prompt.
  const [modelPrompts, setModelPrompts] = useState<Record<SwapModel, string>>(
    () => ({ ...DEFAULT_PROMPT_BY_SWAP_MODEL }),
  );
  const [selectedPanelModel, setSelectedPanelModel] = useState<SwapModel>('nano-banana-pro');
  const setSelectedModelPrompt = useCallback((next: string) => {
    setModelPrompts((prev) => ({ ...prev, [selectedPanelModel]: next }));
  }, [selectedPanelModel]);
  // VIDEO panel state — per-model prompt overrides (per scene), seeded from
  // the rewritten scene visual so both seedance variants start populated. The
  // model selector switches which model's prompt the textarea/JSON view targets
  // and which server tool RUN VIDEO dispatches.
  const [videoModelPrompts, setVideoModelPrompts] = useState<Record<VideoModel, string>>(() => {
    const seed = rewriteVisualWithImageTokens(scene.visual, characters);
    return { 'seedance-2-ref': seed, 'seedance-2-fast': seed };
  });
  const [selectedVideoModel, setSelectedVideoModel] = useState<VideoModel>('seedance-2-ref');
  const setSelectedVideoPrompt = useCallback((next: string) => {
    setVideoModelPrompts((prev) => ({ ...prev, [selectedVideoModel]: next }));
  }, [selectedVideoModel]);
  // Per-model image1 → image2 chains. Each entry is "wait for this image1
  // asset to reach 'ready', then dispatch image2 swap for that model with
  // image1 as the prior reference."
  const [pendingImage2Chains, setPendingImage2Chains] = useState<Array<{ model: SwapModel; image1AssetId: string; customPrompt: string }>>([]);
  // Pending vid- assets waiting on Seedance to finish so we can splice the
  // source's extracted audio onto them via replace_video_audio. Cleared once
  // the asset reaches 'ready' and we dispatch the audio-replace tool.
  const [pendingAudioReplace, setPendingAudioReplace] = useState<Array<{ vidAssetId: string; audioAssetId: string }>>([]);

  const tile1 = deriveTileState(scene, 1, mediaItems);
  const tile2 = deriveTileState(scene, 2, mediaItems);
  const isGenerating = (s: FrameTileState) => s.kind === 'generating';
  const anySwapInFlight = swapsInFlight.size > 0 || isGenerating(tile1) || isGenerating(tile2);
  const inFlightModels1 = useMemo(
    () => Array.from(swapsInFlight)
      .filter((t) => t.endsWith('-1'))
      .map((t) => t.slice(0, -2))
      .filter((m): m is SwapModel => (ALL_SWAP_MODELS as readonly string[]).includes(m)),
    [swapsInFlight],
  );
  const inFlightModels2 = useMemo(
    () => Array.from(swapsInFlight)
      .filter((t) => t.endsWith('-2'))
      .map((t) => t.slice(0, -2))
      .filter((m): m is SwapModel => (ALL_SWAP_MODELS as readonly string[]).includes(m)),
    [swapsInFlight],
  );
  const swapsReady = tile1.kind === 'ready' && tile2.kind === 'ready';

  const runSwap = useCallback(async (
    frameIndex: 1 | 2,
    model: SwapModel,
    opts?: { priorSwapAssetId?: string; safeMode?: boolean; customPrompt?: string },
  ): Promise<{ newAssetId: string } | null> => {
    const tag = `${model}-${frameIndex}`;
    setSwapsInFlight((prev) => {
      const next = new Set(prev);
      next.add(tag);
      return next;
    });
    try {
      const result = await callTool('swap_plan_scene_frame', {
        project_slug: projectSlug,
        scene_index: index,
        frame_index: frameIndex,
        character_asset_ids: characters.map((c) => `@${c.asset_id}`),
        provider: 'kie',
        model,
        ...(opts?.priorSwapAssetId ? { prior_swap_asset_id: opts.priorSwapAssetId } : {}),
        ...(opts?.safeMode ? { safe_mode: true } : {}),
        ...(opts?.customPrompt && opts.customPrompt.trim().length > 0 ? { custom_prompt: opts.customPrompt.trim() } : {}),
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Swap failed';
        toast({ title: `Scene ${index + 1} ${SHORT_LABEL_BY_MODEL[model]} image${frameIndex} swap failed`, description: msg, duration: 5000 });
        return null;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { sidecar?: PlanSidecar; asset_id?: string };
        if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
        if (typeof parsed.asset_id === 'string') return { newAssetId: parsed.asset_id };
      } catch {
        // The job is enqueued either way; sidecar will refresh next read_plan.
      }
      return null;
    } finally {
      setSwapsInFlight((prev) => {
        const next = new Set(prev);
        next.delete(tag);
        return next;
      });
    }
  }, [callTool, projectSlug, index, characters, onSidecarUpdate]);

  const runImagePanel = useCallback(async () => {
    if (anySwapInFlight) return;
    setPendingImage2Chains([]);
    // Fan out image1 swaps across every model, each carrying its own prompt.
    const results = await Promise.all(
      ALL_SWAP_MODELS.map((m) => runSwap(1, m, { customPrompt: modelPrompts[m] })),
    );
    // Queue each successful image1 → image2 chain. The useEffect picks them
    // up as the corresponding image1 assets reach 'ready'.
    const nextChains = ALL_SWAP_MODELS
      .map((m, i) => (results[i] ? { model: m, image1AssetId: results[i]!.newAssetId, customPrompt: modelPrompts[m] } : null))
      .filter((x): x is { model: SwapModel; image1AssetId: string; customPrompt: string } => x !== null);
    if (nextChains.length > 0) setPendingImage2Chains(nextChains);
  }, [anySwapInFlight, runSwap, modelPrompts]);

  // Walk the pending chains; for each entry whose image1 asset is now ready
  // (or errored, in which case we drop the chain), dispatch the image2 swap
  // for that model with image1 as the prior reference, then prune the entry.
  useEffect(() => {
    if (pendingImage2Chains.length === 0) return;
    const stillPending: typeof pendingImage2Chains = [];
    const dispatch: typeof pendingImage2Chains = [];
    for (const entry of pendingImage2Chains) {
      const item = mediaItems.find((m) => m.id === entry.image1AssetId);
      if (!item) {
        stillPending.push(entry);
      } else if (item.status === 'ready') {
        dispatch.push(entry);
      } else if (item.status === 'error') {
        // image1 errored — drop the chain entry without dispatching image2.
      } else {
        stillPending.push(entry);
      }
    }
    if (dispatch.length === 0) return;
    setPendingImage2Chains(stillPending);
    for (const entry of dispatch) {
      void runSwap(2, entry.model, {
        priorSwapAssetId: entry.image1AssetId,
        customPrompt: entry.customPrompt,
      });
    }
  }, [pendingImage2Chains, mediaItems, runSwap]);

  // Retry the currently-selected (failed) swap variant with safe_mode=true.
  // safe_mode swaps the prompt for a tamer "restyle"-language version that
  // avoids the moderation triggers in "replace people / swap subjects". The
  // server ignores safe_mode if custom_prompt is set, so we deliberately omit
  // customPrompt here to let the server's safe-mode default kick in.
  const retryFailedSwap = useCallback((frameIndex: 1 | 2) => {
    const swapId = scene.swap?.[`image${frameIndex}` as 'image1' | 'image2'];
    if (!swapId) return;
    const variantsKey = `image${frameIndex}_variants` as 'image1_variants' | 'image2_variants';
    const variants = scene.swap?.[variantsKey];
    if (!variants) return;
    const matched = (Object.entries(variants) as Array<[string, string]>)
      .find(([, id]) => id === swapId);
    if (!matched) return;
    const model = matched[0] as SwapModel;
    if (!(ALL_SWAP_MODELS as readonly string[]).includes(model)) return;
    const priorSwapAssetId = frameIndex === 2 ? (scene.swap?.image1 ?? undefined) : undefined;
    void runSwap(frameIndex, model, {
      safeMode: true,
      ...(priorSwapAssetId ? { priorSwapAssetId } : {}),
    });
  }, [scene, runSwap]);

  const runAccept = useCallback(async (frameIndex: 1 | 2) => {
    setAccepting((prev) => {
      const next = new Set(prev);
      next.add(frameIndex);
      return next;
    });
    try {
      const result = await callTool('accept_plan_scene_frame_swap', {
        project_slug: projectSlug,
        scene_index: index,
        frame_index: frameIndex,
        accepted: true,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Accept failed';
        toast({ title: `Scene ${index + 1} image${frameIndex} accept failed`, description: msg, duration: 5000 });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { sidecar?: PlanSidecar };
        if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
      } catch {
        // The accept flag is persisted; sidecar refreshes on next read_plan.
      }
    } finally {
      setAccepting((prev) => {
        const next = new Set(prev);
        next.delete(frameIndex);
        return next;
      });
    }
  }, [callTool, projectSlug, index, onSidecarUpdate]);

  const runReplace = useCallback(async (frameIndex: 1 | 2, source: ReplaceSource) => {
    setReplacing((prev) => {
      const next = new Set(prev);
      next.add(frameIndex);
      return next;
    });
    try {
      let assetId: string;
      if (source.kind === 'asset') {
        assetId = source.assetId;
      } else {
        const file = source.file;
        const ext = (() => {
          const dot = file.name.lastIndexOf('.');
          if (dot >= 0) return file.name.slice(dot).toLowerCase();
          if (file.type === 'image/png') return '.png';
          if (file.type === 'image/jpeg') return '.jpg';
          if (file.type === 'image/webp') return '.webp';
          return '.png';
        })();
        const filename = `scene-${index}-image${frameIndex}-user-${Date.now()}${ext}`;
        try {
          const uploaded = await uploadProjectFile(projectSlug, file, filename);
          assetId = uploaded.assetId;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast({ title: `Scene ${index + 1} image${frameIndex} upload failed`, description: msg, duration: 5000 });
          return;
        }
      }
      const result = await callTool('replace_plan_scene_frame_swap', {
        project_slug: projectSlug,
        scene_index: index,
        frame_index: frameIndex,
        asset_id: assetId,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Replace failed';
        toast({ title: `Scene ${index + 1} image${frameIndex} replace failed`, description: msg, duration: 5000 });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { sidecar?: PlanSidecar };
        if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
      } catch {
        // Sidecar refreshes on next read_plan.
      }
    } finally {
      setReplacing((prev) => {
        const next = new Set(prev);
        next.delete(frameIndex);
        return next;
      });
    }
  }, [callTool, projectSlug, index, onSidecarUpdate]);

  const videoGate = useMemo(() => videoReadyForGen(scene), [scene]);

  const handleVideo = useCallback(async () => {
    if (submittingVideo) return;
    if (!videoGate.ok) return;
    // Resolve the source video's extracted audio (`aud-ext-${base}`). Without
    // it we can't run the replace-audio follow-up, so fail loudly here.
    const audioAssetId = sourceAudioAssetId(sourceVideoAssetId);
    const audioItem = mediaItems.find((m) => m.id === audioAssetId);
    if (!audioItem) {
      toast({
        title: `Scene ${index + 1} needs source audio`,
        description: `Run /extract-audio @${sourceVideoAssetId} first — expected ${audioAssetId}.`,
        duration: 5000,
      });
      return;
    }
    setSubmittingVideo(true);
    try {
      const toolName = TOOL_BY_VIDEO_MODEL[selectedVideoModel];
      const toolArgs = buildSeedanceToolArgs(scene, characters, mediaItems, sourceVideoAssetId, videoModelPrompts[selectedVideoModel]);
      const result = await callTool(toolName, {
        project_slug: projectSlug,
        ...toolArgs,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Failed to enqueue Seedance 2';
        toast({ title: `Scene ${index + 1} failed`, description: msg, duration: 5000 });
        return;
      }
      let newVidAssetId: string | null = null;
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { vid_asset_id?: string };
        if (typeof parsed.vid_asset_id === 'string') newVidAssetId = parsed.vid_asset_id;
      } catch {
        // Tool always returns vid_asset_id; if parsing fails we fall back to
        // a toast-only notification and skip the audio chain.
      }
      if (newVidAssetId) {
        setPendingAudioReplace((prev) => [...prev, { vidAssetId: newVidAssetId!, audioAssetId }]);
      }
      const note = swapsReady ? 'Seedance 2 (kie) · 720p · swapped frames' : 'Seedance 2 (kie) · 720p · char refs';
      toast({ title: `Scene ${index + 1} enqueued`, description: note, duration: 2500 });
    } finally {
      setSubmittingVideo(false);
    }
  }, [submittingVideo, videoGate.ok, scene, characters, mediaItems, callTool, projectSlug, index, swapsReady, sourceVideoAssetId, selectedVideoModel, videoModelPrompts]);

  // Walk pendingAudioReplace; when each vid- asset reaches 'ready', dispatch
  // replace_video_audio with the source's extracted audio. Errors are toasted
  // and the entry is dropped either way.
  useEffect(() => {
    if (pendingAudioReplace.length === 0) return;
    const stillPending: typeof pendingAudioReplace = [];
    const dispatch: typeof pendingAudioReplace = [];
    for (const entry of pendingAudioReplace) {
      const item = mediaItems.find((m) => m.id === entry.vidAssetId);
      if (!item) {
        stillPending.push(entry);
      } else if (item.status === 'ready') {
        dispatch.push(entry);
      } else if (item.status === 'error') {
        // vid errored — drop without dispatching.
      } else {
        stillPending.push(entry);
      }
    }
    if (dispatch.length === 0) return;
    setPendingAudioReplace(stillPending);
    for (const entry of dispatch) {
      void (async () => {
        const result = await callTool('replace_video_audio', {
          project_slug: projectSlug,
          asset_id: entry.vidAssetId,
          audio_asset_id: entry.audioAssetId,
        });
        if (result.isError) {
          const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'replace_video_audio failed';
          toast({ title: `Scene ${index + 1} audio splice failed`, description: msg, duration: 5000 });
          return;
        }
        toast({
          title: `Scene ${index + 1} audio spliced`,
          description: `${entry.vidAssetId} ← ${entry.audioAssetId}`,
          duration: 2500,
        });
      })();
    }
  }, [pendingAudioReplace, mediaItems, callTool, projectSlug, index]);

  const videoPayload = useMemo(
    () => buildKieVideoPayload(
      selectedVideoModel,
      scene,
      characters,
      mediaItems,
      sourceVideoAssetId,
      videoModelPrompts[selectedVideoModel],
    ),
    [selectedVideoModel, videoModelPrompts, scene, characters, mediaItems, sourceVideoAssetId],
  );

  const imagePayload = useMemo(
    () => buildKieImagePayload(
      selectedPanelModel,
      characters,
      index,
      1,
      modelPrompts[selectedPanelModel],
    ),
    [selectedPanelModel, modelPrompts, characters, index],
  );

  const bothAccepted = scene.swap?.image1_accepted === true && scene.swap?.image2_accepted === true;

  const duration = (scene.end - scene.start).toFixed(2);

  return (
    <section className="border border-zinc-800/60 rounded bg-zinc-950/40 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 bg-black/40">
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-primary/50">Scene {index + 1}</span>
          <span className="text-primary/90 font-bold">
            {formatTimecode(scene.start)} – {formatTimecode(scene.end)}
          </span>
          <span className="text-primary/40">({duration}s)</span>
        </div>
      </header>
      <ImagePanel
        selectedModel={selectedPanelModel}
        onSelectModel={setSelectedPanelModel}
        prompt={modelPrompts[selectedPanelModel]}
        onPromptChange={setSelectedModelPrompt}
        payload={imagePayload}
        mediaItems={mediaItems}
        projectSlug={projectSlug}
      />
      <SceneFrameRows
        sceneIndex={index}
        scene={scene}
        projectSlug={projectSlug}
        mediaItems={mediaItems}
        inFlightModels1={inFlightModels1}
        inFlightModels2={inFlightModels2}
        accepting={accepting}
        replacing={replacing}
        onAccept={(frameIndex) => { void runAccept(frameIndex); }}
        onReplace={(frameIndex, source) => { void runReplace(frameIndex, source); }}
        onIdleClick={() => { void runImagePanel(); }}
        onErrorRetry={(frameIndex) => retryFailedSwap(frameIndex)}
      />
      {bothAccepted && (
        <VideoPanel
          selectedModel={selectedVideoModel}
          onSelectModel={setSelectedVideoModel}
          prompt={videoModelPrompts[selectedVideoModel]}
          onPromptChange={setSelectedVideoPrompt}
          payload={videoPayload}
          mediaItems={mediaItems}
          projectSlug={projectSlug}
          running={submittingVideo}
          disabled={!videoGate.ok || anySwapInFlight}
          disabledReason={!videoGate.ok ? videoGate.reason : anySwapInFlight ? 'Swap still running' : undefined}
          onRun={() => { void handleVideo(); }}
        />
      )}
    </section>
  );
}

function VideoPanel({ selectedModel, onSelectModel, prompt, onPromptChange, payload, mediaItems, projectSlug, running, disabled, disabledReason, onRun }: {
  selectedModel: VideoModel;
  onSelectModel: (model: VideoModel) => void;
  prompt: string;
  onPromptChange: (next: string) => void;
  payload: unknown;
  mediaItems: MediaItem[];
  projectSlug: string;
  running: boolean;
  disabled: boolean;
  disabledReason?: string;
  onRun: () => void;
}) {
  const [view, setView] = useState<'prompt' | 'json'>('prompt');
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard permission failures
    }
  }, [payload]);
  return (
    <div className="px-3 py-3 border-t border-zinc-800/40 bg-black/30 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60">
        <div className="flex">
          <TabButton active={view === 'prompt'} onClick={() => setView('prompt')} icon={<FileText className="w-3 h-3" />}>
            Prompt
          </TabButton>
          <TabButton active={view === 'json'} onClick={() => setView('json')} icon={<Code className="w-3 h-3" />}>
            JSON
          </TabButton>
        </div>
        {view === 'json' && (
          <button
            type="button"
            onClick={handleCopy}
            title="Copy JSON payload"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-primary/70 hover:text-primary',
              'bg-primary/5 hover:bg-primary/10 border border-primary/20 hover:border-primary/40',
              'transition-colors duration-150',
            )}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <div className="flex items-center gap-x-2">
        {ALL_VIDEO_MODELS.map((m) => (
          <TabButton
            key={m}
            active={selectedModel === m}
            onClick={() => onSelectModel(m)}
            icon={null}
          >
            {m}
          </TabButton>
        ))}
      </div>
      {view === 'prompt' ? (
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={6}
          className={cn(
            'w-full p-2 rounded bg-black/60 border border-zinc-700 text-[11px] font-mono text-primary/90 resize-y',
            'focus:outline-none focus:border-primary/60',
            'placeholder:text-primary/40',
          )}
        />
      ) : (
        <PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />
      )}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onRun}
          disabled={running || disabled}
          title={disabled ? disabledReason : undefined}
          className={cn(
            'h-7 px-3 flex items-center gap-1.5 rounded',
            'text-[11px] font-mono font-bold uppercase tracking-wider',
            'text-violet-300/90 hover:text-violet-200',
            'bg-violet-500/5 hover:bg-violet-500/15 border border-violet-500/30 hover:border-violet-400/60',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
          {running ? 'Running…' : 'Run Video'}
        </button>
      </div>
    </div>
  );
}

// Slug pattern: `@<prefix><id>` where prefix is one of the known asset id
// prefixes plus `plan/` for the synthetic source-frame slug. Restricted to
// these so prompt text like `@Image1` (used by rewriteVisualWithImageTokens)
// doesn't get mis-matched as an asset reference.
const SLUG_TOKEN_REGEX = /"(@(?:img-|vid-|aud-|char-|plan\/)[\w\-./]+)"/g;

function resolveSlugThumb(
  slug: string,
  mediaItems: MediaItem[],
  projectSlug: string,
): string | null {
  const id = slug.startsWith('@') ? slug.slice(1) : slug;
  const planMatch = id.match(/^plan\/(scene-\d+-image\d+-source\.jpg)$/);
  if (planMatch) return `/files/${projectSlug}/plan/${planMatch[1]}`;
  const item = mediaItems.find((m) => m.id === id);
  return item?.thumbnailSrc ?? null;
}

function renderJsonLine(
  line: string,
  mediaItems: MediaItem[],
  projectSlug: string,
  lineKey: number,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  SLUG_TOKEN_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let tokenKey = 0;
  let match: RegExpExecArray | null;
  while ((match = SLUG_TOKEN_REGEX.exec(line)) !== null) {
    if (match.index > lastIndex) parts.push(line.slice(lastIndex, match.index));
    const slug = match[1];
    const thumb = resolveSlugThumb(slug, mediaItems, projectSlug);
    parts.push(
      <span key={`${lineKey}-${tokenKey++}`} className="inline-flex items-center gap-1 align-middle">
        {thumb && (
          <img
            src={thumb}
            alt=""
            className="w-4 h-4 inline-block rounded object-cover ring-1 ring-zinc-700/60 align-middle"
          />
        )}
        <span>&quot;{slug}&quot;</span>
      </span>,
    );
    lastIndex = SLUG_TOKEN_REGEX.lastIndex;
  }
  if (lastIndex < line.length) parts.push(line.slice(lastIndex));
  return parts;
}

function PayloadJsonView({ payload, mediaItems, projectSlug }: {
  payload: unknown;
  mediaItems: MediaItem[];
  projectSlug: string;
}) {
  const text = useMemo(() => JSON.stringify(payload, null, 2), [payload]);
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <pre className="p-2 rounded bg-black/60 border border-zinc-700 text-xs leading-relaxed text-primary/85 font-mono whitespace-pre overflow-x-auto scrollbar-cyan max-h-72">
      {lines.map((line, i) => (
        <span key={i}>
          {renderJsonLine(line, mediaItems, projectSlug, i)}
          {i < lines.length - 1 && '\n'}
        </span>
      ))}
    </pre>
  );
}

function TabButton({ active, onClick, icon, children }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 px-3 flex items-center gap-1.5',
        'text-[11px] font-mono font-bold uppercase tracking-wider',
        'border-b-2 transition-colors duration-150',
        active
          ? 'text-primary border-primary'
          : 'text-primary/40 border-transparent hover:text-primary/70',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

type PlanSlotKind = 'source' | 'character';

function isAcceptableForSlot(payload: SidebarDragPayload, kind: PlanSlotKind): boolean {
  if (typeof payload.id !== 'string') return false;
  if (kind === 'source') return payload.id.startsWith('vid-');
  return payload.id.startsWith('char-') || payload.id.startsWith('img-');
}

function PlanHeaderSlot({ label, kind, item, onDrop }: {
  label: string;
  kind: PlanSlotKind;
  item: MediaItem | null;
  onDrop: (assetId: string) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      if (!isAcceptableForSlot(payload, kind)) {
        const want = kind === 'source' ? 'vid-* video' : 'char-* or img-* asset';
        toast({ title: 'Wrong asset type', description: `Drop a ${want} on this slot.`, duration: 3000 });
        return;
      }
      if (payload.id) onDrop(payload.id);
    } catch {
      // Malformed payload — ignore.
    }
  };
  const src = item?.thumbnailSrc ?? item?.filePath ?? null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-wider text-primary/50">{label}</span>
      <div
        className={cn(
          'relative w-44 aspect-video bg-zinc-900 border rounded overflow-hidden flex items-center justify-center transition-colors',
          dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
        )}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDrop={handleDrop}
      >
        {item && src ? (
          <img src={src} alt={item.slug} className="w-full h-full object-contain" loading="lazy" />
        ) : item ? (
          <FileText className="w-6 h-6 text-primary/40" />
        ) : (
          <span className="text-[11px] font-mono text-primary/50 px-2 text-center">drop {kind === 'source' ? 'video' : 'character'}</span>
        )}
        {dragActive && (
          <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/30 pointer-events-none">
            <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-50 font-bold">drop to set</span>
          </div>
        )}
      </div>
      <div className="text-[10px] font-mono text-primary/60 truncate w-44">{item?.slug ?? '—'}</div>
    </div>
  );
}

function PlanHeader({ sourceId, charAId, charBId, mediaItems, duration, scenesCount, canGenerate, generating, onSourceDrop, onCharADrop, onCharBDrop, onGenerate }: {
  sourceId: string | null;
  charAId: string | null;
  charBId: string | null;
  mediaItems: MediaItem[];
  duration: number | null;
  scenesCount: number | null;
  canGenerate: boolean;
  generating: boolean;
  onSourceDrop: (id: string) => void;
  onCharADrop: (id: string) => void;
  onCharBDrop: (id: string) => void;
  onGenerate: () => void;
}) {
  const sourceItem = sourceId ? mediaItems.find((m) => m.id === sourceId) ?? null : null;
  const charAItem = charAId ? mediaItems.find((m) => m.id === charAId) ?? null : null;
  const charBItem = charBId ? mediaItems.find((m) => m.id === charBId) ?? null : null;
  return (
    <div className="mb-6 pb-4 border-b border-zinc-800/60">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h1 className="text-lg font-bold text-primary font-mono uppercase tracking-wider">Plan: char swap</h1>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating || !canGenerate}
          title={canGenerate ? 'Generate plan from these slots' : 'Drop a video source and two distinct characters'}
          className={cn(
            'h-8 px-3 flex items-center gap-1.5 rounded',
            'text-xs font-mono font-bold uppercase tracking-wider',
            'text-primary hover:text-white',
            'bg-primary/10 hover:bg-primary/20 border border-primary/40 hover:border-primary/70',
            'transition-colors duration-150',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
          {generating ? 'Generating…' : 'Generate Plan'}
        </button>
      </div>
      <div className="flex flex-wrap gap-4 mb-4">
        <PlanHeaderSlot label="Video Source" kind="source" item={sourceItem} onDrop={onSourceDrop} />
        <PlanHeaderSlot label="Char A" kind="character" item={charAItem} onDrop={onCharADrop} />
        <PlanHeaderSlot label="Char B" kind="character" item={charBItem} onDrop={onCharBDrop} />
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs font-mono items-center">
        <dt className="text-primary/60">Duration</dt>
        <dd className="text-primary/90">{duration != null ? `${duration.toFixed(2)}s` : '—'}</dd>
        <dt className="text-primary/60">Scenes</dt>
        <dd className="text-primary/90">
          {scenesCount != null ? `${scenesCount} (all ${SCENE_SECONDS}s, except last)` : '—'}
        </dd>
      </dl>
    </div>
  );
}

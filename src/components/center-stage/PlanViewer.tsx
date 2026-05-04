import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Film, Loader2, MapPin, X, FileText, Code, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { useMountKey } from '@/contexts/MountKeyContext';
import { ViewerToolbar } from './viewer-shared';

interface PlanScene {
  start: number;
  end: number;
  visual: string;
  swap?: { image1: string | null; image2: string | null } | null;
}

interface PlanSidecar {
  scenes: PlanScene[];
  total_duration_s: number;
  max_scene_seconds: number;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  model: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PlanSidecar }
  | { kind: 'error'; message: string };

function formatTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

interface PlanViewerProps {
  item: MediaItem | null;
  emptyOverride: boolean;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}

export function PlanViewer({ item, emptyOverride, mediaItems, projectSlug, callTool, onClose }: PlanViewerProps) {
  useMountKey('viewer');

  if (emptyOverride && !item) {
    return (
      <PlanEmptyState
        mediaItems={mediaItems}
        projectSlug={projectSlug}
        callTool={callTool}
        onClose={onClose}
      />
    );
  }

  if (!item) {
    return (
      <PlanShell title="PLAN" slug="plan" onClose={onClose}>
        <div className="flex items-center justify-center w-full h-full text-primary/40">
          <FileText className="w-16 h-16" />
        </div>
      </PlanShell>
    );
  }

  return (
    <PlanPopulated
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

function PlanPopulated({ item, mediaItems, projectSlug, callTool, onClose }: {
  item: MediaItem;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}) {
  const { dispatch } = useCommandDispatch();
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!projectSlug) return;
    cancelledRef.current = false;
    void (async () => {
      const result = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelledRef.current) return;
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Failed to read plan';
        setLoadState({ kind: 'error', message: msg });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed: PlanSidecar = JSON.parse(text);
        setLoadState({ kind: 'ready', data: parsed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadState({ kind: 'error', message: `Failed to parse plan: ${msg}` });
      }
    })();
    return () => { cancelledRef.current = true; };
  }, [callTool, projectSlug, item.id, item.prompt]);

  return (
    <PlanShell title="PLAN" slug={item.slug} onClose={onClose}>
      <div className="flex-1 overflow-y-auto scrollbar-cyan">
        {loadState.kind === 'loading' && (
          <div className="flex items-center justify-center w-full h-full">
            <Loader2 className="w-6 h-6 animate-spin text-primary/60" />
          </div>
        )}
        {loadState.kind === 'error' && (
          <div className="flex flex-col items-center justify-center w-full h-full p-8 gap-3 text-center">
            <FileText className="w-12 h-12 text-primary/30" />
            <p className="text-sm text-primary/60 font-mono max-w-md">{loadState.message}</p>
            <p className="text-xs text-muted-foreground/60 font-mono">
              Run <code className="text-primary/80">/plan-vis @vid-...</code> to generate a plan first.
            </p>
          </div>
        )}
        {loadState.kind === 'ready' && (
          <PlanScenes
            data={loadState.data}
            mediaItems={mediaItems}
            projectSlug={projectSlug}
            callTool={callTool}
            dispatch={dispatch}
            onSidecarUpdate={(sidecar) => setLoadState({ kind: 'ready', data: sidecar })}
          />
        )}
      </div>
    </PlanShell>
  );
}

type SwapProvider = 'kie';
type SwapModel = 'nano-banana-pro' | 'gpt-image-2';

const DEFAULT_SWAP_MODEL: SwapModel = 'nano-banana-pro';

const PROVIDER_OPTIONS: { value: SwapProvider; label: string; disabled?: boolean }[] = [
  { value: 'kie', label: 'kie' },
  // Future: { value: 'fal', label: 'fal', disabled: true },
];

const MODEL_OPTIONS_BY_PROVIDER: Record<SwapProvider, { value: SwapModel; label: string }[]> = {
  kie: [
    { value: 'nano-banana-pro', label: 'nano-banana-pro' },
    { value: 'gpt-image-2', label: 'gpt-image-2' },
  ],
};

function PlanScenes({ data, mediaItems, projectSlug, callTool, dispatch, onSidecarUpdate }: {
  data: PlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  dispatch: (input: string) => Promise<boolean>;
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}) {
  const [swapProvider, setSwapProvider] = useState<SwapProvider>('kie');
  const [swapModel, setSwapModel] = useState<SwapModel>(DEFAULT_SWAP_MODEL);

  const sourceItem = useMemo(
    () => mediaItems.find((m) => m.id === data.source_asset_id) ?? null,
    [mediaItems, data.source_asset_id],
  );
  const characterItems = useMemo(
    () => data.characters.map((c) => ({
      character: c,
      item: mediaItems.find((m) => m.id === c.asset_id) ?? null,
    })),
    [mediaItems, data.characters],
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="mb-6 pb-4 border-b border-zinc-800/60">
        <h1 className="text-lg font-bold text-primary font-mono uppercase tracking-wider mb-3">Plan: visualization</h1>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs font-mono items-center">
          <dt className="text-primary/60">Source</dt>
          <dd>
            <AssetCard
              item={sourceItem}
              fallbackLabel={data.source_asset_id}
            />
          </dd>
          <dt className="text-primary/60">Duration</dt>
          <dd className="text-primary/90">{data.total_duration_s.toFixed(2)}s</dd>
          <dt className="text-primary/60">Scenes</dt>
          <dd className="text-primary/90">{data.scenes.length} ({data.max_scene_seconds}s each except the last)</dd>
          <dt className="text-primary/60">Characters</dt>
          <dd>
            <div className="flex flex-wrap gap-2">
              {characterItems.map(({ character, item }) => (
                <AssetCard
                  key={character.asset_id}
                  item={item}
                  fallbackLabel={character.name || character.asset_id}
                />
              ))}
            </div>
          </dd>
          <dt className="text-primary/60">Model</dt>
          <dd className="text-primary/90">{data.model}</dd>
          <dt className="text-primary/60">Swap provider</dt>
          <dd>
            <select
              value={swapProvider}
              onChange={(e) => {
                const next = e.target.value as SwapProvider;
                setSwapProvider(next);
                const firstModel = MODEL_OPTIONS_BY_PROVIDER[next][0]?.value;
                if (firstModel) setSwapModel(firstModel);
              }}
              className={cn(
                'h-7 px-2 rounded bg-black/60 border border-zinc-700 text-xs font-mono text-primary/90',
                'focus:outline-none focus:border-primary/60',
              )}
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p.value} value={p.value} disabled={p.disabled}>{p.label}</option>
              ))}
            </select>
          </dd>
          <dt className="text-primary/60">Swap model</dt>
          <dd>
            <select
              value={swapModel}
              onChange={(e) => setSwapModel(e.target.value as SwapModel)}
              className={cn(
                'h-7 px-2 rounded bg-black/60 border border-zinc-700 text-xs font-mono text-primary/90',
                'focus:outline-none focus:border-primary/60',
              )}
            >
              {MODEL_OPTIONS_BY_PROVIDER[swapProvider].map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </dd>
        </dl>
      </div>
      <div className="space-y-5">
        {data.scenes.map((scene, idx) => (
          <SceneBlock
            key={`${scene.start}-${scene.end}-${idx}`}
            scene={scene}
            index={idx}
            characters={data.characters}
            mediaItems={mediaItems}
            projectSlug={projectSlug}
            swapProvider={swapProvider}
            swapModel={swapModel}
            callTool={callTool}
            dispatch={dispatch}
            onSidecarUpdate={onSidecarUpdate}
          />
        ))}
      </div>
    </div>
  );
}

function AssetCard({ item, fallbackLabel }: {
  item: MediaItem | null;
  fallbackLabel: string;
}) {
  const src = item?.thumbnailSrc ?? item?.filePath ?? null;
  const label = item?.slug ?? fallbackLabel;
  return (
    <div className="inline-flex items-center gap-2 pr-2 rounded border border-zinc-700/60 bg-black/40 overflow-hidden">
      <div className="w-10 h-10 shrink-0 bg-zinc-900 flex items-center justify-center">
        {src ? (
          <img src={src} alt={label} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <FileText className="w-4 h-4 text-primary/40" />
        )}
      </div>
      <span className="text-xs font-mono text-primary/85">{label}</span>
    </div>
  );
}

type FrameTileState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

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
    if (src) return { kind: 'ready', src };
    return { kind: 'generating' };
  }
  return { kind: 'generating' };
}

function SceneFrameTiles({ sceneIndex, scene, projectSlug, mediaItems, onRetry, swapsInFlight }: {
  sceneIndex: number;
  scene: PlanScene;
  projectSlug: string;
  mediaItems: MediaItem[];
  onRetry: (frameIndex: 1 | 2) => void;
  swapsInFlight: Set<1 | 2>;
}) {
  // Cache-bust the source-frame thumbnails on scene-boundary changes — when
  // /plan-vis re-runs and produces different chunks, timestamps shift and the
  // same filename now points at a different frame.
  const v = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;
  const sourceUrl = (i: 1 | 2) =>
    `/files/${projectSlug}/plan/scene-${sceneIndex}-image${i}-source.jpg?v=${v}`;
  return (
    <div className="flex gap-2 px-3 py-3 border-b border-zinc-800/40 bg-black/20">
      <SceneFrameTile
        sourceSrc={sourceUrl(1)}
        state={deriveTileState(scene, 1, mediaItems)}
        label={`image1 · first ${formatTimecode(scene.start)}`}
        inFlight={swapsInFlight.has(1)}
        onRetry={() => onRetry(1)}
      />
      <SceneFrameTile
        sourceSrc={sourceUrl(2)}
        state={deriveTileState(scene, 2, mediaItems)}
        label={`image2 · last ${formatTimecode(scene.end)}`}
        inFlight={swapsInFlight.has(2)}
        onRetry={() => onRetry(2)}
      />
    </div>
  );
}

function SceneFrameTile({ sourceSrc, state, label, inFlight, onRetry }: {
  sourceSrc: string;
  state: FrameTileState;
  label: string;
  inFlight: boolean;
  onRetry: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const showSource = state.kind !== 'ready';
  const showSpinner = inFlight || state.kind === 'generating';
  return (
    <div className="flex flex-col gap-1">
      <div className="relative w-40 aspect-video bg-zinc-900 border border-zinc-700/60 rounded overflow-hidden flex items-center justify-center">
        {state.kind === 'ready' ? (
          <img
            src={state.src}
            alt={label}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : showSource && !errored ? (
          <img
            src={sourceSrc}
            alt={label}
            className={cn('w-full h-full object-cover', state.kind === 'error' && 'opacity-50')}
            loading="lazy"
            onError={() => setErrored(true)}
          />
        ) : (
          <span className="text-[10px] font-mono text-primary/40 px-2 text-center">missing</span>
        )}
        {showSpinner && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Loader2 className="w-5 h-5 animate-spin text-primary/80" />
          </div>
        )}
        {state.kind === 'error' && !inFlight && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-950/70">
            <span className="text-[10px] font-mono text-red-200/90 px-2 text-center line-clamp-2">
              {state.message}
            </span>
            <button
              type="button"
              onClick={onRetry}
              className={cn(
                'h-6 px-2 flex items-center gap-1 rounded',
                'text-[10px] font-mono uppercase tracking-wider',
                'text-red-100 hover:text-white',
                'bg-red-500/20 hover:bg-red-500/30 border border-red-400/40 hover:border-red-300/70',
              )}
            >
              Retry
            </button>
          </div>
        )}
      </div>
      <div className="text-[10px] font-mono text-primary/50">{label}</div>
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

function buildSeedancePayload(
  scene: PlanScene,
  characters: PlanSidecar['characters'],
  mediaItems: MediaItem[],
): unknown {
  const swapped = readySwapAssetIds(scene, mediaItems);
  const imageSlugs = swapped
    ? swapped.map((id) => `@${id}`)
    : characters.map((c) => `@${c.asset_id}`);
  return {
    tool: 'generate_seedance2_r2v_fal',
    args: {
      prompt: rewriteVisualWithImageTokens(scene.visual, characters),
      image_slugs: imageSlugs,
      resolution: '720p',
      aspect_ratio: '16:9',
      duration: 'auto',
      generate_audio: true,
    },
  };
}

function SceneBlock({ scene, index, characters, mediaItems, projectSlug, swapProvider, swapModel, callTool, dispatch, onSidecarUpdate }: {
  scene: PlanScene;
  index: number;
  characters: PlanSidecar['characters'];
  mediaItems: MediaItem[];
  projectSlug: string;
  swapProvider: SwapProvider;
  swapModel: SwapModel;
  callTool: UseMcpResult['callTool'];
  dispatch: (input: string) => Promise<boolean>;
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}) {
  void dispatch;
  const [view, setView] = useState<'prompt' | 'json'>('prompt');
  const [copied, setCopied] = useState(false);
  const [submittingVideo, setSubmittingVideo] = useState(false);
  const [swapsInFlight, setSwapsInFlight] = useState<Set<1 | 2>>(new Set());

  const tile1 = deriveTileState(scene, 1, mediaItems);
  const tile2 = deriveTileState(scene, 2, mediaItems);
  const isGenerating = (s: FrameTileState) => s.kind === 'generating';
  const anySwapInFlight = swapsInFlight.size > 0 || isGenerating(tile1) || isGenerating(tile2);
  const swapsReady = tile1.kind === 'ready' && tile2.kind === 'ready';

  const runSwap = useCallback(async (frameIndex: 1 | 2) => {
    setSwapsInFlight((prev) => {
      const next = new Set(prev);
      next.add(frameIndex);
      return next;
    });
    try {
      const result = await callTool('swap_plan_scene_frame', {
        project_slug: projectSlug,
        scene_index: index,
        frame_index: frameIndex,
        character_asset_ids: characters.map((c) => `@${c.asset_id}`),
        provider: swapProvider,
        model: swapModel,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Swap failed';
        toast({ title: `Scene ${index + 1} image${frameIndex} swap failed`, description: msg, duration: 5000 });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { sidecar?: PlanSidecar };
        if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
      } catch {
        // The job is enqueued either way; sidecar will refresh next read_plan.
      }
    } finally {
      setSwapsInFlight((prev) => {
        const next = new Set(prev);
        next.delete(frameIndex);
        return next;
      });
    }
  }, [callTool, projectSlug, index, characters, onSidecarUpdate, swapProvider, swapModel]);

  const handleImage = useCallback(() => {
    if (anySwapInFlight) return;
    void runSwap(1);
    void runSwap(2);
  }, [anySwapInFlight, runSwap]);

  const handleVideo = useCallback(async () => {
    if (submittingVideo) return;
    setSubmittingVideo(true);
    try {
      const payload = buildSeedancePayload(scene, characters, mediaItems) as { args: Record<string, unknown> };
      const result = await callTool('generate_seedance2_r2v_fal', {
        project_slug: projectSlug,
        ...payload.args,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Failed to enqueue Seedance 2 r2v';
        toast({ title: `Scene ${index + 1} failed`, description: msg, duration: 5000 });
        return;
      }
      const note = swapsReady ? 'Seedance 2 r2v · 720p · swapped frames' : 'Seedance 2 r2v · 720p · char refs';
      toast({ title: `Scene ${index + 1} enqueued`, description: note, duration: 2500 });
    } finally {
      setSubmittingVideo(false);
    }
  }, [submittingVideo, scene, characters, mediaItems, callTool, projectSlug, index, swapsReady]);

  const json = useMemo(
    () => JSON.stringify(buildSeedancePayload(scene, characters, mediaItems), null, 2),
    [scene, characters, mediaItems],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard permission failures
    }
  }, [json]);

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
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleImage}
            disabled={anySwapInFlight}
            title={anySwapInFlight
              ? 'Swap in progress…'
              : `Run ${swapModel} to swap the two on-screen subjects in both source frames with the two character refs`}
            className={cn(
              'h-7 px-2.5 flex items-center gap-1.5 rounded',
              'text-[11px] font-mono font-bold uppercase tracking-wider',
              'text-primary/90 hover:text-primary',
              'bg-primary/5 hover:bg-primary/15 border border-primary/30 hover:border-primary/60',
              'transition-colors duration-150',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {anySwapInFlight ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
            Image
          </button>
          <button
            type="button"
            onClick={handleVideo}
            disabled={submittingVideo || anySwapInFlight}
            title={swapsReady
              ? 'Enqueue Seedance 2 r2v at 720p with the swapped frames as @Image1 / @Image2'
              : 'Enqueue Seedance 2 r2v at 720p with the raw character refs (run Image first to use swapped frames)'}
            className={cn(
              'h-7 px-2.5 flex items-center gap-1.5 rounded',
              'text-[11px] font-mono font-bold uppercase tracking-wider',
              'text-violet-300/90 hover:text-violet-200',
              'bg-violet-500/5 hover:bg-violet-500/15 border border-violet-500/30 hover:border-violet-400/60',
              'transition-colors duration-150',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {submittingVideo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
            Video
          </button>
        </div>
      </header>
      <SceneFrameTiles
        sceneIndex={index}
        scene={scene}
        projectSlug={projectSlug}
        mediaItems={mediaItems}
        onRetry={(frameIndex) => { void runSwap(frameIndex); }}
        swapsInFlight={swapsInFlight}
      />
      <div className="flex items-center justify-between px-3 pt-2 gap-2 border-b border-zinc-800/40">
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
      {view === 'prompt' ? (
        <p className="px-4 py-3 text-sm leading-relaxed text-primary/75 whitespace-pre-wrap">
          {scene.visual}
        </p>
      ) : (
        <pre className="px-4 py-3 text-xs leading-relaxed text-primary/85 font-mono whitespace-pre overflow-x-auto scrollbar-cyan">
          {json}
        </pre>
      )}
    </section>
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

function PlanEmptyState({ mediaItems, projectSlug, callTool, onClose }: {
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}) {
  const sourceCandidates = useMemo(
    () => mediaItems.filter((m) => m.type === 'video'),
    [mediaItems],
  );
  const characterCandidates = useMemo(
    () => mediaItems.filter((m) => m.id.startsWith('char-') || m.id.startsWith('img-')),
    [mediaItems],
  );
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [selectedCharA, setSelectedCharA] = useState<string>('');
  const [selectedCharB, setSelectedCharB] = useState<string>('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!selectedSource && sourceCandidates.length > 0) {
      setSelectedSource(sourceCandidates[0].id);
    }
  }, [sourceCandidates, selectedSource]);

  useEffect(() => {
    if (!selectedCharA && characterCandidates.length > 0) {
      setSelectedCharA(characterCandidates[0].id);
    }
    if (!selectedCharB && characterCandidates.length > 1) {
      setSelectedCharB(characterCandidates[1].id);
    }
  }, [characterCandidates, selectedCharA, selectedCharB]);

  const canGenerate =
    Boolean(selectedSource) &&
    Boolean(selectedCharA) &&
    Boolean(selectedCharB) &&
    selectedCharA !== selectedCharB;

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !projectSlug) return;
    setGenerating(true);
    try {
      const result = await callTool('plan_visualization', {
        source_asset_id: selectedSource,
        project_slug: projectSlug,
        character_asset_ids: [selectedCharA, selectedCharB],
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Failed to generate plan';
        toast({ title: 'Plan generation failed', description: msg, duration: 5000 });
        return;
      }
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Plan generated', description: 'Loading your plan…', duration: 2500 });
    } finally {
      setGenerating(false);
    }
  }, [canGenerate, selectedSource, selectedCharA, selectedCharB, projectSlug, callTool]);

  const blockingMessage =
    sourceCandidates.length === 0
      ? 'No video assets in this project yet — upload one first.'
      : characterCandidates.length < 2
      ? `Need 2 char-* or img-* assets (have ${characterCandidates.length}).`
      : null;

  return (
    <PlanShell title="PLAN" slug="plan (not yet generated)" onClose={onClose}>
      <div className="flex flex-col items-center justify-center w-full h-full p-8 gap-5">
        <MapPin className="w-14 h-14 text-primary/30" />
        <div className="text-center space-y-1.5 max-w-md">
          <h2 className="text-base font-mono font-bold text-primary/90 uppercase tracking-wider">No plan yet</h2>
          <p className="text-sm text-primary/60">
            Pick a transcribed source and the two character assets to swap into every chunk. We'll even-split the clip into 10–15s chunks, edit the first/last frames with nano-banana-pro (2K), and assemble a Seedance 2 multimodal prompt per chunk.
          </p>
        </div>
        {blockingMessage ? (
          <p className="text-xs text-muted-foreground/60 font-mono">{blockingMessage}</p>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-primary/50 w-16 text-right">source</span>
              <select
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={generating}
                className={cn(
                  'h-8 px-2 rounded bg-black/60 border border-zinc-700 text-sm font-mono text-primary/90 min-w-[14rem]',
                  'focus:outline-none focus:border-primary/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {sourceCandidates.map((m) => (
                  <option key={m.id} value={m.id}>{m.slug}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-primary/50 w-16 text-right">char A</span>
              <select
                value={selectedCharA}
                onChange={(e) => setSelectedCharA(e.target.value)}
                disabled={generating}
                className={cn(
                  'h-8 px-2 rounded bg-black/60 border border-zinc-700 text-sm font-mono text-primary/90 min-w-[14rem]',
                  'focus:outline-none focus:border-primary/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {characterCandidates.map((m) => (
                  <option key={m.id} value={m.id}>{m.slug}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-primary/50 w-16 text-right">char B</span>
              <select
                value={selectedCharB}
                onChange={(e) => setSelectedCharB(e.target.value)}
                disabled={generating}
                className={cn(
                  'h-8 px-2 rounded bg-black/60 border border-zinc-700 text-sm font-mono text-primary/90 min-w-[14rem]',
                  'focus:outline-none focus:border-primary/60',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {characterCandidates.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.id === selectedCharA}>{m.slug}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || !canGenerate}
              className={cn(
                'mt-1 h-8 px-3 flex items-center gap-1.5 rounded',
                'text-xs font-mono font-bold uppercase tracking-wider',
                'text-violet-300/90 hover:text-violet-200',
                'bg-violet-500/5 hover:bg-violet-500/15 border border-violet-500/30 hover:border-violet-400/60',
                'transition-colors duration-150',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
              Generate Plan
            </button>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/50 font-mono text-center max-w-md">
          Source must be a processed video (sampled frames + <code className="text-primary/60">elevenlabs.json</code> with word timings).
          If missing, run <code className="text-primary/60">/process-video</code> then <code className="text-primary/60">/transcribe</code>.
        </p>
      </div>
    </PlanShell>
  );
}

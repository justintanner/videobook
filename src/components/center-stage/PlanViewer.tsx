import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Film, Loader2, MapPin, X, FileText } from 'lucide-react';
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

function PlanPopulated({ item, projectSlug, callTool, onClose }: {
  item: MediaItem;
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
          <PlanScenes data={loadState.data} dispatch={dispatch} />
        )}
      </div>
    </PlanShell>
  );
}

function PlanScenes({ data, dispatch }: {
  data: PlanSidecar;
  dispatch: (input: string) => Promise<boolean>;
}) {
  const characterLabel = data.characters.length === 0
    ? 'none'
    : data.characters.map((c) => c.name).join(', ');

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="mb-6 pb-4 border-b border-zinc-800/60">
        <h1 className="text-lg font-bold text-primary font-mono uppercase tracking-wider mb-3">Plan: visualization</h1>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs font-mono">
          <dt className="text-primary/60">Source</dt>
          <dd className="text-primary/90">{data.source_asset_id}</dd>
          <dt className="text-primary/60">Duration</dt>
          <dd className="text-primary/90">{data.total_duration_s.toFixed(2)}s</dd>
          <dt className="text-primary/60">Scenes</dt>
          <dd className="text-primary/90">{data.scenes.length} (≤{data.max_scene_seconds}s each)</dd>
          <dt className="text-primary/60">Characters</dt>
          <dd className="text-primary/90">{characterLabel}</dd>
          <dt className="text-primary/60">Model</dt>
          <dd className="text-primary/90">{data.model}</dd>
        </dl>
      </div>
      <div className="space-y-5">
        {data.scenes.map((scene, idx) => (
          <SceneBlock key={`${scene.start}-${scene.end}-${idx}`} scene={scene} index={idx} dispatch={dispatch} />
        ))}
      </div>
    </div>
  );
}

function SceneBlock({ scene, index, dispatch }: {
  scene: PlanScene;
  index: number;
  dispatch: (input: string) => Promise<boolean>;
}) {
  const handleImage = useCallback(() => {
    void dispatch(`/image ${scene.visual}`);
  }, [dispatch, scene.visual]);
  const handleVideo = useCallback(() => {
    void dispatch(`/video ${scene.visual}`);
  }, [dispatch, scene.visual]);

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
            title={`Open the image gen panel pre-filled with this scene's visual`}
            className={cn(
              'h-7 px-2.5 flex items-center gap-1.5 rounded',
              'text-[11px] font-mono font-bold uppercase tracking-wider',
              'text-primary/90 hover:text-primary',
              'bg-primary/5 hover:bg-primary/15 border border-primary/30 hover:border-primary/60',
              'transition-colors duration-150',
            )}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            Image
          </button>
          <button
            type="button"
            onClick={handleVideo}
            title={`Open the video gen panel pre-filled with this scene's visual`}
            className={cn(
              'h-7 px-2.5 flex items-center gap-1.5 rounded',
              'text-[11px] font-mono font-bold uppercase tracking-wider',
              'text-violet-300/90 hover:text-violet-200',
              'bg-violet-500/5 hover:bg-violet-500/15 border border-violet-500/30 hover:border-violet-400/60',
              'transition-colors duration-150',
            )}
          >
            <Film className="w-3.5 h-3.5" />
            Video
          </button>
        </div>
      </header>
      <p className="px-4 py-3 text-sm leading-relaxed text-primary/75 whitespace-pre-wrap">
        {scene.visual}
      </p>
    </section>
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
    () => mediaItems.filter((m) => m.id.startsWith('char-')),
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
      ? `Need 2 character assets (have ${characterCandidates.length}) — create char-* assets first.`
      : null;

  return (
    <PlanShell title="PLAN" slug="plan (not yet generated)" onClose={onClose}>
      <div className="flex flex-col items-center justify-center w-full h-full p-8 gap-5">
        <MapPin className="w-14 h-14 text-primary/30" />
        <div className="text-center space-y-1.5 max-w-md">
          <h2 className="text-base font-mono font-bold text-primary/90 uppercase tracking-wider">No plan yet</h2>
          <p className="text-sm text-primary/60">
            Pick a transcribed source and the two character assets to swap into every chunk. We'll even-split the clip into 10–15s chunks, edit the first/last frames with gpt-image-2 (2K), and assemble a Seedance 2 multimodal prompt per chunk.
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

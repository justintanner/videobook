import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Film, Loader2, MapPin, X, FileText, Code, Copy, Check, RefreshCw, Images, Mic, Volume2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { useMountKey } from '@/contexts/MountKeyContext';
import { ViewerToolbar } from './viewer-shared';
import { uploadProjectFile } from '@/lib/upload';
import {
  falWanImageSizeForDimensions,
  kieImageAspectRatioForDimensions,
  seedanceAspectRatioForDimensions,
  sourceAspectFromDimensions,
  type SourceAspect,
} from '@/lib/plan-aspect';

interface PlanScene {
  start: number;
  end: number;
  visual: string;
  // Sibling files inside the `plan` asset that hold the per-scene clip and
  // its extracted audio. Stamped at /plan-vis time so the render path can
  // address them as @plan/<filename> without ID reconciliation. Optional in
  // this type purely so we can detect old plans that lack the fields and
  // surface a "re-run /plan-vis" notice.
  clip_filename?: string;
  audio_filename?: string;
  // Audit data: per-scene frames sampled and sent to the vision model at
  // plan-vis time. Older plans pre-dating the audit feature lack this.
  frames?: Array<{ name: string; t: number }>;
  swap?: {
    image1: string | null;
    image2: string | null;
    image1_variants?: Record<string, string>;
    image2_variants?: Record<string, string>;
    video?: string | null;
  } | null;
}

interface PlanSidecar {
  formula?: 'char_swap';
  scenes: PlanScene[];
  total_duration_s: number;
  max_scene_seconds: number;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  model: string;
  analysis_prompt?: string;
  user_context?: string;
  word_count?: number;
}

type PlanFormula = 'char_swap' | 'storyboard_video' | 'clip_show';

interface StoryboardVideoPlanSidecar {
  formula: 'storyboard_video';
  source_image_asset_id: string;
  source_image_asset_ids?: string[];
  source_image_analysis?: {
    prompt: string;
    shot?: string;
    pose?: string;
  } | null;
  storyboard_brief: string;
  loop_video: boolean;
  storyboard_prompt: string;
  video_prompt: string;
  storyboard_asset_id?: string | null;
  video_asset_id?: string | null;
  storyboard_model: 'generate_gpt_image';
  video_model: 'generate_seedance2_video' | 'generate_seedance2_fast_video';
  duration_s: number;
  aspect_ratio: '16:9';
  resolution: '720p';
  total_duration_s: number;
}

type ClipShowPlacement = 'before' | 'after' | 'both';

interface ClipShowCharacter {
  asset_id: string;
  name: string;
  description: string;
  elevenlabs_voice_id: string;
}

interface ClipShowSegment {
  clip_asset_id: string;
  clip_summary: string;
  placement: ClipShowPlacement;
  intro_dialog: string;
  outro_dialog: string;
  dialog: string;
  joke_notes: string;
  quality_notes: string;
  first_frame_prompt: string;
  video_prompt: string;
  audio_asset_id?: string | null;
  first_frame_asset_id?: string | null;
  video_asset_id?: string | null;
}

interface ClipShowPlanSidecar {
  formula: 'clip_show';
  character: ClipShowCharacter;
  clip_asset_ids: string[];
  show_brief: string;
  tone: string;
  model: 'gpt-5.5';
  audio_model: 'elevenlabs';
  first_frame_model: 'generate_gpt_image';
  video_model: 'generate_seedance2_video';
  video_resolution: '720p';
  video_aspect_ratio: '16:9';
  video_duration_s: number;
  total_duration_s: number;
  segments: ClipShowSegment[];
}

type AnyPlanSidecar = PlanSidecar | StoryboardVideoPlanSidecar | ClipShowPlanSidecar;

function planFormula(sidecar: AnyPlanSidecar | null): PlanFormula | null {
  if (!sidecar) return null;
  if (sidecar.formula === 'clip_show') return 'clip_show';
  return sidecar.formula === 'storyboard_video' ? 'storyboard_video' : 'char_swap';
}

function isStoryboardVideoPlan(sidecar: AnyPlanSidecar | null): sidecar is StoryboardVideoPlanSidecar {
  return sidecar?.formula === 'storyboard_video';
}

function isClipShowPlan(sidecar: AnyPlanSidecar | null): sidecar is ClipShowPlanSidecar {
  return sidecar?.formula === 'clip_show';
}

function storyboardSourceImageIds(sidecar: StoryboardVideoPlanSidecar | null): string[] {
  if (!sidecar) return [];
  const ids: string[] = [];
  for (const value of [sidecar.source_image_asset_id, ...(sidecar.source_image_asset_ids ?? [])]) {
    const id = value.replace(/^@/, '').trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
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
  resetKey?: number;
  onClose: () => void;
}

export function PlanViewer({ item, mediaItems, projectSlug, callTool, resetKey, onClose }: PlanViewerProps) {
  useMountKey('viewer');
  return (
    <PlanBody
      item={item}
      mediaItems={mediaItems}
      projectSlug={projectSlug}
      callTool={callTool}
      resetKey={resetKey}
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
    <div className="flex-1 min-w-0 flex items-center justify-center overflow-hidden">
      <div className="w-full h-full min-w-0 relative">
        <div className="absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
          <ViewerToolbar
            left={
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-emerald-300/90 drop-shadow-[0_0_4px_rgba(52,211,153,0.5)]">
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
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-emerald-300 transition-colors duration-150 rounded hover:bg-emerald-500/10"
              >
                <X className="w-4 h-4 stroke-[2.5]" />
              </button>
            }
          />
          <div className="flex-1 min-w-0 bg-black flex flex-col min-h-0 relative">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// Rough pre-generation estimate only; the real chunker runs server-side and
// produces variable 7–14s scenes aligned to camera cuts and motion-settle
// points. 10s = midpoint.
const APPROX_SCENE_SECONDS = 10;

function PlanBody({ item, mediaItems, projectSlug, callTool, resetKey, onClose }: {
  item: MediaItem | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  resetKey?: number;
  onClose: () => void;
}) {
  const { dispatch } = useCommandDispatch();
  const [sidecar, setSidecar] = useState<AnyPlanSidecar | null>(null);
  const [activeFormula, setActiveFormula] = useState<PlanFormula | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [pendingCharA, setPendingCharA] = useState<string | null>(null);
  const [pendingCharB, setPendingCharB] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const cancelledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveFormula(null);
  }, [resetKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [activeFormula, resetKey]);

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
        const parsed: AnyPlanSidecar = JSON.parse(text);
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

  const charSidecar = planFormula(sidecar) === 'char_swap' ? sidecar as PlanSidecar : null;
  const storyboardVideoSidecar = isStoryboardVideoPlan(sidecar) ? sidecar : null;
  const clipShowSidecar = isClipShowPlan(sidecar) ? sidecar : null;

  // Effective slot values: pending wins, else fall back to sidecar.
  const sourceId = pendingSource ?? charSidecar?.source_asset_id ?? null;
  const charAId = pendingCharA ?? charSidecar?.characters[0]?.asset_id ?? null;
  const charBId = pendingCharB ?? charSidecar?.characters[1]?.asset_id ?? null;

  const sourceItem = useMemo(
    () => (sourceId ? mediaItems.find((m) => m.id === sourceId) ?? null : null),
    [sourceId, mediaItems],
  );
  const sourceAspect = useMemo(
    () => sourceAspectFromDimensions(sourceItem?.width, sourceItem?.height),
    [sourceItem?.width, sourceItem?.height],
  );
  const duration = sourceItem?.duration ?? null;
  const scenesCount = duration && duration > 0
    ? Math.max(1, Math.ceil(duration / APPROX_SCENE_SECONDS))
    : null;

  const slotsDifferFromSidecar = charSidecar
    ? charSidecar.source_asset_id !== sourceId
      || (charSidecar.characters[0]?.asset_id ?? null) !== charAId
      || (charSidecar.characters[1]?.asset_id ?? null) !== charBId
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
          const parsed: AnyPlanSidecar = JSON.parse(text);
          setSidecar(parsed);
          setActiveFormula(planFormula(parsed) ?? 'char_swap');
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

  const currentFormula = planFormula(sidecar);
  const slug = sidecar ? (item?.slug ?? 'plan') : 'plan (not yet generated)';
  const title = activeFormula == null
    ? 'PLAN'
    : activeFormula === 'clip_show'
    ? 'PLAN: CLIP SHOW'
    : activeFormula === 'storyboard_video' ? 'PLAN: STORYBOARD' : 'PLAN: CHAR SWAP';
  const showSelector = activeFormula == null;
  const backToTemplates = useCallback(() => setActiveFormula(null), []);

  return (
    <PlanShell title={title} slug={slug} onClose={onClose}>
      <div
        ref={scrollRef}
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-domain"
        style={{ '--scrollbar-rgb': '52, 211, 153' } as React.CSSProperties}
      >
        <div className="w-full min-w-0 px-4 sm:px-6 py-5">
          {showSelector ? (
            <PlanTemplateSelector
              currentFormula={currentFormula}
              onSelect={setActiveFormula}
            />
          ) : activeFormula === 'char_swap' ? (
            <>
              <PlanHeader
                sourceId={sourceId}
                charAId={charAId}
                charBId={charBId}
                mediaItems={mediaItems}
                sourceAspect={sourceAspect}
                duration={duration}
                scenesCount={scenesCount}
                canGenerate={canGenerate}
                generating={generating}
                onSourceDrop={setPendingSource}
                onCharADrop={setPendingCharA}
                onCharBDrop={setPendingCharB}
                onGenerate={() => { void handleGenerate(); }}
                onBack={backToTemplates}
              />
              {charSidecar && (
                <PlanAuditFromSidecar sidecar={charSidecar} projectSlug={projectSlug} />
              )}
              {!charSidecar && sourceId && charAId && charBId && charAId !== charBId && (
                <PlanPreviewBlock
                  sourceId={sourceId}
                  charAId={charAId}
                  charBId={charBId}
                  projectSlug={projectSlug}
                  callTool={callTool}
                />
              )}
              {charSidecar && (
                <PlanScenes
                  data={charSidecar}
                  mediaItems={mediaItems}
                  sourceAspect={sourceAspect}
                  projectSlug={projectSlug}
                  callTool={callTool}
                  dispatch={dispatch}
                  onSidecarUpdate={(next) => setSidecar(next)}
                />
              )}
            </>
          ) : activeFormula === 'storyboard_video' ? (
            <StoryboardVideoPlanFormula
              sidecar={storyboardVideoSidecar}
              mediaItems={mediaItems}
              projectSlug={projectSlug}
              callTool={callTool}
              onSidecarUpdate={(next) => setSidecar(next)}
              onBack={backToTemplates}
            />
          ) : (
            <ClipShowPlanFormula
              sidecar={clipShowSidecar}
              mediaItems={mediaItems}
              projectSlug={projectSlug}
              callTool={callTool}
              onSidecarUpdate={(next) => setSidecar(next)}
              onBack={backToTemplates}
            />
          )}
        </div>
      </div>
    </PlanShell>
  );
}

function PlanBackButton({ onBack }: {
  onBack: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onBack}
      title="Back to templates"
      className={cn(
        'h-8 px-2.5 flex items-center gap-1.5 rounded',
        'text-[10px] font-mono font-bold uppercase tracking-wider',
        'text-emerald-300/65 hover:text-emerald-200',
        'bg-zinc-950/60 hover:bg-emerald-500/10 border border-zinc-700/70 hover:border-emerald-500/50',
        'transition-colors duration-150',
      )}
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      Templates
    </button>
  );
}

function PlanTemplateSelector({ currentFormula, onSelect }: {
  currentFormula: PlanFormula | null;
  onSelect: (formula: PlanFormula) => void;
}) {
  const templates: Array<{ id: Exclude<PlanFormula, 'char_swap'>; label: string; icon: React.ReactNode; meta: string }> = [
    { id: 'clip_show', label: 'Clip Show', icon: <Mic className="w-4 h-4" />, meta: 'char-* + vid-*' },
    { id: 'storyboard_video', label: 'Storyboard', icon: <Images className="w-4 h-4" />, meta: 'img-*' },
  ];
  return (
    <div className="min-h-full flex flex-col">
      <div className="mb-5 pb-4 border-b border-zinc-800/70">
        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-300/45">Plan</div>
        <h1 className="mt-1 text-lg font-bold text-emerald-300 font-mono uppercase tracking-wider">Templates</h1>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {templates.map((template) => {
          const isCurrent = currentFormula === template.id;
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template.id)}
              className={cn(
                'min-h-32 p-4 rounded border text-left transition-colors',
                'bg-zinc-950/50 hover:bg-emerald-500/10',
                isCurrent ? 'border-emerald-500/65' : 'border-zinc-800/75 hover:border-emerald-500/50',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn(
                    'w-8 h-8 rounded border flex items-center justify-center shrink-0',
                    isCurrent ? 'border-emerald-500/70 text-emerald-200 bg-emerald-500/15' : 'border-zinc-700/80 text-emerald-300/65 bg-black/35',
                  )}>
                    {template.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-mono font-bold uppercase tracking-wider text-emerald-200 truncate">{template.label}</span>
                    <span className="block mt-0.5 text-[10px] font-mono uppercase tracking-wider text-emerald-300/40 truncate">{template.meta}</span>
                  </span>
                </div>
                {isCurrent && (
                  <span className="shrink-0 h-5 px-2 rounded border border-emerald-500/40 bg-emerald-500/10 text-[9px] font-mono font-bold uppercase tracking-wider text-emerald-200/80">
                    Current
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {currentFormula === 'char_swap' && (
        <button
          type="button"
          onClick={() => onSelect('char_swap')}
          className={cn(
            'mt-4 w-full min-h-20 p-4 rounded border text-left transition-colors',
            'bg-zinc-950/40 hover:bg-emerald-500/10 border-zinc-800/75 hover:border-emerald-500/45',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-8 h-8 rounded border border-zinc-700/80 flex items-center justify-center shrink-0 text-emerald-300/55 bg-black/35">
                <MapPin className="w-4 h-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-mono font-bold uppercase tracking-wider text-emerald-200 truncate">Legacy Plan</span>
                <span className="block mt-0.5 text-[10px] font-mono uppercase tracking-wider text-emerald-300/35 truncate">char swap</span>
              </span>
            </div>
            <span className="shrink-0 h-5 px-2 rounded border border-emerald-500/35 bg-emerald-500/10 text-[9px] font-mono font-bold uppercase tracking-wider text-emerald-200/70">
              Current
            </span>
          </div>
        </button>
      )}
    </div>
  );
}

function videoModelFromTool(toolName: string | undefined): VideoModel {
  return toolName === 'generate_seedance2_fast_video' ? 'seedance-2-fast' : 'seedance-2-ref';
}

function normalizeStoryboardVideoPrompt(prompt: string): string {
  return prompt
    .replaceAll('@[storyboard ref]', '[Image 1]')
    .replaceAll('@[character ref]', '[Image 2]');
}

function deriveStoryboardTileState(assetId: string | null | undefined, mediaItems: MediaItem[]): FrameTileState {
  if (!assetId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === assetId);
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'storyboard gen failed' };
  if (item.status === 'ready') {
    const src = item.thumbnailSrc ?? item.filePath ?? null;
    if (src) return { kind: 'ready', src };
  }
  return { kind: 'generating' };
}

function deriveStoryboardVideoState(sidecar: StoryboardVideoPlanSidecar | null, mediaItems: MediaItem[], projectSlug: string): VideoTileState {
  const vidId = sidecar?.video_asset_id;
  if (!vidId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === vidId);
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'video gen failed' };
  if (item.status === 'ready') return { kind: 'ready', src: `/files/${projectSlug}/${vidId}/original.mp4` };
  return { kind: 'generating', label: item.status === 'replacing-audio' ? 'splicing audio...' : 'generating...' };
}

function buildStoryboardVideoPayload(
  videoModel: VideoModel,
  sidecar: StoryboardVideoPlanSidecar | null,
  videoPrompt: string,
): { model: string; input: Record<string, unknown> } {
  const storyboardId = sidecar?.storyboard_asset_id ?? 'img-storyboard';
  const sourceImageIds = storyboardSourceImageIds(sidecar);
  const referenceImageUrls = [`@${storyboardId}`, ...(sourceImageIds.length > 0 ? sourceImageIds : ['img-source']).map((id) => `@${id}`)];
  return {
    model: KIE_MODEL_NAME_BY_VIDEO[videoModel],
    input: {
      prompt: normalizeStoryboardVideoPrompt(videoPrompt),
      reference_image_urls: referenceImageUrls,
      resolution: '720p',
      aspect_ratio: '16:9',
      duration: sidecar?.duration_s ?? 15,
      generate_audio: true,
    },
  };
}

function StoryboardVideoPlanFormula({ sidecar, mediaItems, projectSlug, callTool, onSidecarUpdate, onBack }: {
  sidecar: StoryboardVideoPlanSidecar | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: StoryboardVideoPlanSidecar) => void;
  onBack: () => void;
}) {
  const [sourceImageIds, setSourceImageIds] = useState<string[]>(() => storyboardSourceImageIds(sidecar));
  const [storyboardBrief, setStoryboardBrief] = useState(() => sidecar?.storyboard_brief ?? '');
  const [loopVideo, setLoopVideo] = useState(() => sidecar?.loop_video ?? false);
  const [storyboardPrompt, setStoryboardPrompt] = useState(() => sidecar?.storyboard_prompt ?? '');
  const [videoPrompt, setVideoPrompt] = useState(() => sidecar?.video_prompt ?? '');
  const [storyboardPromptEdited, setStoryboardPromptEdited] = useState(false);
  const [videoPromptEdited, setVideoPromptEdited] = useState(false);
  const [selectedVideoModel, setSelectedVideoModel] = useState<VideoModel>(() => videoModelFromTool(sidecar?.video_model));
  const [durationS, setDurationS] = useState(() => sidecar?.duration_s ?? 15);
  const [savingPlan, setSavingPlan] = useState(false);
  const [generatingStoryboard, setGeneratingStoryboard] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [replacingStoryboard, setReplacingStoryboard] = useState(false);
  const [replacingVideo, setReplacingVideo] = useState(false);

  const sidecarKey = [
    sidecar?.source_image_asset_id ?? '',
    ...(sidecar?.source_image_asset_ids ?? []),
    sidecar?.storyboard_asset_id ?? '',
    sidecar?.video_asset_id ?? '',
    sidecar?.storyboard_brief ?? '',
    sidecar?.loop_video ? 'loop' : 'no-loop',
    sidecar?.storyboard_prompt ?? '',
    sidecar?.video_prompt ?? '',
    sidecar?.video_model ?? '',
    sidecar?.duration_s ?? '',
  ].join('|');

  useEffect(() => {
    if (!sidecar) return;
    setSourceImageIds(storyboardSourceImageIds(sidecar));
    setStoryboardBrief(sidecar.storyboard_brief ?? '');
    setLoopVideo(sidecar.loop_video ?? false);
    setStoryboardPrompt(sidecar.storyboard_prompt);
    setVideoPrompt(normalizeStoryboardVideoPrompt(sidecar.video_prompt));
    setStoryboardPromptEdited(false);
    setVideoPromptEdited(false);
    setSelectedVideoModel(videoModelFromTool(sidecar.video_model));
    setDurationS(sidecar.duration_s);
  }, [sidecar, sidecarKey]);

  const sourceItems = useMemo(
    () => sourceImageIds.map((id) => ({
      id,
      item: mediaItems.find((m) => m.id === id) ?? null,
    })),
    [sourceImageIds, mediaItems],
  );
  const outputAspect = useMemo(() => sourceAspectFromDimensions(16, 9), []);
  const storyboardState = useMemo(
    () => deriveStoryboardTileState(sidecar?.storyboard_asset_id, mediaItems),
    [sidecar?.storyboard_asset_id, mediaItems],
  );
  const videoTileState = useMemo(
    () => deriveStoryboardVideoState(sidecar, mediaItems, projectSlug),
    [sidecar, mediaItems, projectSlug],
  );
  const videoPayload = useMemo(
    () => buildStoryboardVideoPayload(selectedVideoModel, sidecar, videoPrompt),
    [selectedVideoModel, sidecar, videoPrompt],
  );

  const handleStoryboardBriefChange = useCallback((next: string) => {
    setStoryboardBrief(next);
    setStoryboardPromptEdited(false);
    setVideoPromptEdited(false);
  }, []);

  const handleLoopVideoChange = useCallback((next: boolean) => {
    setLoopVideo(next);
    setStoryboardPromptEdited(false);
    setVideoPromptEdited(false);
  }, []);

  const handleStoryboardPromptChange = useCallback((next: string) => {
    setStoryboardPrompt(next);
    setStoryboardPromptEdited(true);
  }, []);

  const handleVideoPromptChange = useCallback((next: string) => {
    setVideoPrompt(next);
    setVideoPromptEdited(true);
  }, []);

  const savePlan = useCallback(async (nextSourceImageIds: string[], opts?: { resetPrompts?: boolean }) => {
    const primarySourceImageId = nextSourceImageIds[0];
    if (!primarySourceImageId) return null;
    setSavingPlan(true);
    try {
      const args: Record<string, unknown> = {
        project_slug: projectSlug,
        source_image_asset_id: primarySourceImageId,
        source_image_asset_ids: nextSourceImageIds,
        storyboard_brief: storyboardBrief,
        loop_video: loopVideo,
        video_model: TOOL_BY_VIDEO_MODEL[selectedVideoModel],
        duration_s: durationS,
      };
      if (opts?.resetPrompts) args.rebuild_prompts = true;
      if (!opts?.resetPrompts && storyboardPromptEdited && storyboardPrompt.trim().length > 0) args.storyboard_prompt = storyboardPrompt;
      if (!opts?.resetPrompts && videoPromptEdited && videoPrompt.trim().length > 0) args.video_prompt = normalizeStoryboardVideoPrompt(videoPrompt.trim());
      const result = await callTool('plan_storyboard_video', args);
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Plan update failed';
        toast({ title: 'Plan update failed', description: msg, duration: 5000 });
        return null;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { sidecar?: StoryboardVideoPlanSidecar };
      if (!parsed.sidecar) return null;
      onSidecarUpdate(parsed.sidecar);
      setSourceImageIds(storyboardSourceImageIds(parsed.sidecar));
      setStoryboardBrief(parsed.sidecar.storyboard_brief ?? '');
      setLoopVideo(parsed.sidecar.loop_video ?? false);
      setStoryboardPrompt(parsed.sidecar.storyboard_prompt);
      setVideoPrompt(normalizeStoryboardVideoPrompt(parsed.sidecar.video_prompt));
      setStoryboardPromptEdited(false);
      setVideoPromptEdited(false);
      await callTool('sync', { project_slug: projectSlug });
      return parsed.sidecar;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: 'Plan update failed', description: msg, duration: 5000 });
      return null;
    } finally {
      setSavingPlan(false);
    }
  }, [callTool, projectSlug, storyboardBrief, loopVideo, selectedVideoModel, durationS, storyboardPromptEdited, storyboardPrompt, videoPromptEdited, videoPrompt, onSidecarUpdate]);

  const handleSourceDrop = useCallback((assetId: string) => {
    if (!assetId.startsWith('img-')) {
      toast({ title: 'Wrong asset type', description: `Drop an img-* source image, got ${assetId}.`, duration: 3000 });
      return;
    }
    if (sourceImageIds.includes(assetId)) {
      toast({ title: 'Source already added', description: `@${assetId} is already in the source list.`, duration: 2500 });
      return;
    }
    const nextSourceImageIds = [...sourceImageIds, assetId];
    setSourceImageIds(nextSourceImageIds);
    setStoryboardPrompt('');
    setVideoPrompt('');
    setStoryboardPromptEdited(false);
    setVideoPromptEdited(false);
    void savePlan(nextSourceImageIds, { resetPrompts: true });
  }, [sourceImageIds, savePlan]);

  const handleSourceRemove = useCallback((assetId: string) => {
    if (sourceImageIds.length <= 1) {
      toast({ title: 'Source required', description: 'Keep at least one source image for the plan.', duration: 2500 });
      return;
    }
    const nextSourceImageIds = sourceImageIds.filter((id) => id !== assetId);
    setSourceImageIds(nextSourceImageIds);
    setStoryboardPrompt('');
    setVideoPrompt('');
    setStoryboardPromptEdited(false);
    setVideoPromptEdited(false);
    void savePlan(nextSourceImageIds, { resetPrompts: true });
  }, [sourceImageIds, savePlan]);

  const handleSourcePromote = useCallback((assetId: string) => {
    if (sourceImageIds[0] === assetId) return;
    const nextSourceImageIds = [assetId, ...sourceImageIds.filter((id) => id !== assetId)];
    setSourceImageIds(nextSourceImageIds);
    setStoryboardPrompt('');
    setVideoPrompt('');
    setStoryboardPromptEdited(false);
    setVideoPromptEdited(false);
    void savePlan(nextSourceImageIds, { resetPrompts: true });
  }, [sourceImageIds, savePlan]);

  const persistStoryboard = useCallback(async (assetId: string) => {
    const result = await callTool('replace_plan_storyboard_video_storyboard', {
      project_slug: projectSlug,
      asset_id: assetId,
    });
    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Storyboard replace failed';
      toast({ title: 'Storyboard replace failed', description: msg, duration: 5000 });
      return null;
    }
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { sidecar?: StoryboardVideoPlanSidecar };
    if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
    return parsed.sidecar ?? null;
  }, [callTool, projectSlug, onSidecarUpdate]);

  const persistVideo = useCallback(async (assetId: string) => {
    const result = await callTool('replace_plan_storyboard_video_video', {
      project_slug: projectSlug,
      asset_id: assetId,
    });
    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Video replace failed';
      toast({ title: 'Video replace failed', description: msg, duration: 5000 });
      return null;
    }
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { sidecar?: StoryboardVideoPlanSidecar };
    if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
    return parsed.sidecar ?? null;
  }, [callTool, projectSlug, onSidecarUpdate]);

  const handleGenerateStoryboard = useCallback(async () => {
    if (sourceImageIds.length === 0 || generatingStoryboard) return;
    setGeneratingStoryboard(true);
    try {
      const shouldRebuildPrompt = storyboardState.kind === 'error' && !storyboardPromptEdited;
      const plan = await savePlan(sourceImageIds, { resetPrompts: shouldRebuildPrompt });
      if (!plan) return;
      const result = await callTool('generate_gpt_image', {
        project_slug: projectSlug,
        prompt: plan.storyboard_prompt,
        image_slugs: storyboardSourceImageIds(plan).slice(0, 1).map((id) => `@${id}`),
        aspect_ratio: '16:9',
        resolution: '2K',
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Failed to enqueue GPT Image 2';
        toast({ title: 'Storyboard generation failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { img_asset_id?: string };
      if (parsed.img_asset_id) await persistStoryboard(parsed.img_asset_id);
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Storyboard enqueued', description: 'GPT Image 2', duration: 2500 });
    } finally {
      setGeneratingStoryboard(false);
    }
  }, [sourceImageIds, generatingStoryboard, storyboardState.kind, storyboardPromptEdited, savePlan, callTool, projectSlug, persistStoryboard]);

  const handleGenerateVideo = useCallback(async () => {
    if (sourceImageIds.length === 0 || generatingVideo) return;
    setGeneratingVideo(true);
    try {
      const plan = await savePlan(sourceImageIds);
      if (!plan) return;
      const storyboardId = plan.storyboard_asset_id;
      if (!storyboardId) {
        toast({ title: 'Storyboard required', description: 'Generate or drop a storyboard image before video.', duration: 3500 });
        return;
      }
      const prompt = normalizeStoryboardVideoPrompt(plan.video_prompt);
      const toolName = TOOL_BY_VIDEO_MODEL[selectedVideoModel];
      const sourceSlugs = storyboardSourceImageIds(plan).map((id) => `@${id}`);
      const imageSlugs = [`@${storyboardId}`, ...sourceSlugs];
      const result = await callTool(toolName, {
        project_slug: projectSlug,
        prompt,
        image_slugs: imageSlugs,
        resolution: '720p',
        aspect_ratio: '16:9',
        duration: String(plan.duration_s),
        generate_audio: true,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? `Failed to enqueue ${LABEL_BY_VIDEO_MODEL[selectedVideoModel]}`;
        toast({ title: 'Video generation failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { vid_asset_id?: string };
      if (parsed.vid_asset_id) await persistVideo(parsed.vid_asset_id);
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Video enqueued', description: selectedVideoModel, duration: 2500 });
    } finally {
      setGeneratingVideo(false);
    }
  }, [sourceImageIds, generatingVideo, savePlan, selectedVideoModel, callTool, projectSlug, persistVideo]);

  const handleStoryboardReplace = useCallback(async (assetId: string) => {
    setReplacingStoryboard(true);
    try {
      await persistStoryboard(assetId);
    } finally {
      setReplacingStoryboard(false);
    }
  }, [persistStoryboard]);

  const handleVideoReplace = useCallback(async (assetId: string) => {
    setReplacingVideo(true);
    try {
      await persistVideo(assetId);
    } finally {
      setReplacingVideo(false);
    }
  }, [persistVideo]);

  const storyboardAssetId = sidecar?.storyboard_asset_id ?? null;
  const canGenerateStoryboard = sourceImageIds.length > 0 && !savingPlan && !generatingStoryboard;
  const canGenerateVideo = sourceImageIds.length > 0 && Boolean(storyboardAssetId) && !savingPlan && !generatingVideo;

  return (
    <div className="space-y-5">
      <div className="mb-6 pb-4 border-b border-zinc-800/60">
        <div className="flex items-center justify-between mb-3 gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <PlanBackButton onBack={onBack} />
            <h1 className="text-lg font-bold text-emerald-300 font-mono uppercase tracking-wider truncate">Plan: storyboard</h1>
          </div>
          <button
            type="button"
            onClick={() => { if (sourceImageIds.length > 0) void savePlan(sourceImageIds); }}
            disabled={sourceImageIds.length === 0 || savingPlan}
            title={sourceImageIds.length > 0 ? 'Save plan prompts' : 'Drop a source image'}
            className={cn(
              'h-8 px-3 flex items-center gap-1.5 rounded',
              'text-xs font-mono font-bold uppercase tracking-wider',
              'text-emerald-300 hover:text-white',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 hover:border-emerald-500/70',
              'transition-colors duration-150',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {savingPlan ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {savingPlan ? 'Saving...' : 'Save Plan'}
          </button>
        </div>
        <StoryboardSourceDropZone
          sources={sourceItems.map(({ id, item }) => ({
            id,
            src: item?.thumbnailSrc ?? item?.filePath ?? null,
            label: item?.slug ?? `@${id}`,
            aspect: sourceAspectFromDimensions(item?.width, item?.height),
          }))}
          onDropSource={handleSourceDrop}
          onRemoveSource={handleSourceRemove}
          onPromoteSource={handleSourcePromote}
        />
        <StoryboardDirectionPanel
          storyboardBrief={storyboardBrief}
          loopVideo={loopVideo}
          onBriefChange={handleStoryboardBriefChange}
          onLoopChange={handleLoopVideoChange}
        />
      </div>

      <section className="border border-zinc-800/60 rounded bg-zinc-950/40 overflow-hidden">
        <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 bg-black/40">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="inline-flex w-5 h-5 items-center justify-center rounded-full border border-emerald-500/40 text-emerald-300/80 text-[10px] font-bold">1</span>
            <span className="text-emerald-300/70 uppercase tracking-wider">Generate storyboard image</span>
          </div>
          <button
            type="button"
            onClick={() => { void handleGenerateStoryboard(); }}
            disabled={!canGenerateStoryboard}
            title={canGenerateStoryboard ? 'Generate storyboard with GPT Image 2' : 'Drop a source image first'}
            className={cn(
              'h-7 px-2.5 flex items-center gap-1.5 rounded',
              'text-[10px] font-mono font-bold uppercase tracking-wider',
              'text-emerald-300 hover:text-white',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/35 hover:border-emerald-500/70',
              'transition-colors duration-150',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {generatingStoryboard ? <Loader2 className="w-3 h-3 animate-spin" /> : <Images className="w-3 h-3" />}
            {generatingStoryboard ? 'Generating...' : 'Generate'}
          </button>
        </header>
        <div className="p-3 grid grid-cols-1 md:grid-cols-[minmax(12rem,18rem)_1fr] gap-3">
          <StoryboardImageSlot
            state={storyboardState}
            sourceAspect={outputAspect}
            assetId={storyboardAssetId}
            replacing={replacingStoryboard}
            generating={generatingStoryboard}
            onIdleClick={() => { void handleGenerateStoryboard(); }}
            onReplace={(assetId) => { void handleStoryboardReplace(assetId); }}
            onErrorRetry={() => { void handleGenerateStoryboard(); }}
            onRegen={() => { void handleGenerateStoryboard(); }}
          />
          <div className="min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 mb-1">Storyboard prompt</div>
            <PromptEditor
              value={storyboardPrompt}
              onChange={handleStoryboardPromptChange}
              mediaItems={mediaItems}
              projectSlug={projectSlug}
            />
          </div>
        </div>
      </section>

      <section className="border border-zinc-800/60 rounded bg-zinc-950/40 overflow-hidden">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-black/40 text-xs font-mono">
          <span className="inline-flex w-5 h-5 items-center justify-center rounded-full border border-emerald-500/40 text-emerald-300/80 text-[10px] font-bold">2</span>
          <span className="text-emerald-300/70 uppercase tracking-wider">Generate video</span>
        </header>
        <div className="px-3 py-3 bg-black/20">
          <div className="mb-3 flex items-center gap-3 text-[11px] font-mono">
            <label className="flex items-center gap-1.5">
              <span className="text-emerald-300/50 uppercase tracking-wider">Duration:</span>
              <input
                type="number"
                min={4}
                max={15}
                value={durationS}
                onChange={(e) => setDurationS(Math.min(15, Math.max(4, Number(e.target.value) || 15)))}
                className="h-6 w-14 px-1.5 rounded bg-black/60 border border-zinc-700 text-emerald-300/90 focus:outline-none focus:border-emerald-500/60"
              />
            </label>
            <span className="text-emerald-300/45">16:9 / 2K GPT storyboard / 720p video</span>
          </div>
          <VideoPanel
            selectedModel={selectedVideoModel}
            onSelectModel={setSelectedVideoModel}
            models={STORYBOARD_VIDEO_MODELS}
            prompt={videoPrompt}
            onPromptChange={handleVideoPromptChange}
            payload={videoPayload}
            mediaItems={mediaItems}
            sourceAspect={outputAspect}
            projectSlug={projectSlug}
            disabled={!canGenerateVideo}
            disabledReason={sourceImageIds.length === 0 ? 'Drop a source image first' : !storyboardAssetId ? 'Generate or drop a storyboard first' : generatingVideo ? 'Video gen submitting...' : undefined}
            videoTileState={videoTileState}
            videoAssetId={sidecar?.video_asset_id ?? null}
            replacing={replacingVideo || generatingVideo}
            onIdleClick={() => { void handleGenerateVideo(); }}
            onReplace={(vidAssetId) => { void handleVideoReplace(vidAssetId); }}
            onErrorRetry={() => { void handleGenerateVideo(); }}
            onRegen={() => { void handleGenerateVideo(); }}
          />
        </div>
      </section>
    </div>
  );
}

type AudioTileState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

function deriveClipShowAudioState(assetId: string | null | undefined, mediaItems: MediaItem[], projectSlug: string): AudioTileState {
  if (!assetId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === assetId);
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'audio gen failed' };
  if (item.status === 'ready') return { kind: 'ready', src: item.filePath || `/files/${projectSlug}/${assetId}/original.mp3` };
  return { kind: 'generating' };
}

function deriveClipShowVideoState(assetId: string | null | undefined, mediaItems: MediaItem[], projectSlug: string): VideoTileState {
  if (!assetId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === assetId);
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'video gen failed' };
  if (item.status === 'ready') return { kind: 'ready', src: `/files/${projectSlug}/${assetId}/original.mp4` };
  return { kind: 'generating', label: item.status === 'replacing-audio' ? 'splicing audio...' : 'generating...' };
}

function clipShowSidecarKey(sidecar: ClipShowPlanSidecar | null): string {
  if (!sidecar) return '';
  return [
    sidecar.character.asset_id,
    sidecar.clip_asset_ids.join(','),
    sidecar.show_brief,
    sidecar.tone,
    sidecar.segments.map((s) => [
      s.clip_asset_id,
      s.dialog,
      s.first_frame_prompt,
      s.video_prompt,
      s.audio_asset_id ?? '',
      s.first_frame_asset_id ?? '',
      s.video_asset_id ?? '',
    ].join(':')).join('|'),
  ].join('|');
}

function ClipShowPlanFormula({ sidecar, mediaItems, projectSlug, callTool, onSidecarUpdate, onBack }: {
  sidecar: ClipShowPlanSidecar | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: ClipShowPlanSidecar) => void;
  onBack: () => void;
}) {
  const [characterId, setCharacterId] = useState(() => sidecar?.character.asset_id ?? '');
  const [clipIds, setClipIds] = useState<string[]>(() => sidecar?.clip_asset_ids ?? []);
  const [showBrief, setShowBrief] = useState(() => sidecar?.show_brief ?? '');
  const [tone, setTone] = useState(() => sidecar?.tone ?? 'sharp, playful, punchy, not mean');
  const [generatingPlan, setGeneratingPlan] = useState(false);
  const sidecarKey = clipShowSidecarKey(sidecar);

  useEffect(() => {
    if (!sidecar) return;
    setCharacterId(sidecar.character.asset_id);
    setClipIds(sidecar.clip_asset_ids);
    setShowBrief(sidecar.show_brief);
    setTone(sidecar.tone);
  }, [sidecar, sidecarKey]);

  const characterItem = useMemo(
    () => (characterId ? mediaItems.find((m) => m.id === characterId) ?? null : null),
    [characterId, mediaItems],
  );
  const clipItems = useMemo(
    () => clipIds.map((id) => ({ id, item: mediaItems.find((m) => m.id === id) ?? null })),
    [clipIds, mediaItems],
  );

  const handleCharacterDrop = useCallback((assetId: string) => {
    if (!assetId.startsWith('char-')) {
      toast({ title: 'Wrong asset type', description: `Drop a char-* host, got ${assetId}.`, duration: 3000 });
      return;
    }
    setCharacterId(assetId);
  }, []);

  const handleClipDrop = useCallback((assetId: string) => {
    if (!assetId.startsWith('vid-')) {
      toast({ title: 'Wrong asset type', description: `Drop vid-* clips, got ${assetId}.`, duration: 3000 });
      return;
    }
    setClipIds((prev) => (prev.includes(assetId) ? prev : [...prev, assetId]));
  }, []);

  const handleClipRemove = useCallback((assetId: string) => {
    setClipIds((prev) => prev.filter((id) => id !== assetId));
  }, []);

  const canGeneratePlan = characterId.length > 0 && clipIds.length > 0 && !generatingPlan;

  const handleGeneratePlan = useCallback(async () => {
    if (!canGeneratePlan) return;
    setGeneratingPlan(true);
    try {
      const result = await callTool('plan_clip_show', {
        project_slug: projectSlug,
        character_asset_id: characterId,
        clip_asset_ids: clipIds,
        show_brief: showBrief,
        tone,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Clip Show plan failed';
        toast({ title: 'Clip Show failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { sidecar?: ClipShowPlanSidecar };
      if (!parsed.sidecar) return;
      onSidecarUpdate(parsed.sidecar);
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Clip Show planned', description: `${parsed.sidecar.segments.length} segment${parsed.sidecar.segments.length === 1 ? '' : 's'}`, duration: 2500 });
    } finally {
      setGeneratingPlan(false);
    }
  }, [canGeneratePlan, callTool, projectSlug, characterId, clipIds, showBrief, tone, onSidecarUpdate]);

  return (
    <div className="space-y-5">
      <section className="mb-6 overflow-hidden rounded border border-emerald-500/20 bg-zinc-950/70">
        <div className="flex items-center justify-between gap-3 border-b border-emerald-500/15 bg-black/45 px-3 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <PlanBackButton onBack={onBack} />
            <h1 className="text-lg font-bold text-emerald-300 font-mono uppercase tracking-wider truncate">Plan: clip show</h1>
          </div>
          <button
            type="button"
            onClick={() => { void handleGeneratePlan(); }}
            disabled={!canGeneratePlan}
            title={canGeneratePlan ? 'Generate Clip Show plan with GPT-5.5' : 'Drop a host character and at least one clip'}
            className={cn(
              'h-8 px-3 flex items-center gap-1.5 rounded',
              'text-xs font-mono font-bold uppercase tracking-wider',
              'text-emerald-300 hover:text-white',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 hover:border-emerald-500/70',
              'transition-colors duration-150',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {generatingPlan ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
            {generatingPlan ? 'Planning...' : 'Generate Plan'}
          </button>
        </div>
        <div className="p-3 space-y-3">
          <div className="grid grid-cols-1 xl:grid-cols-[14rem_minmax(0,1fr)] gap-3">
            <ClipShowCharacterDropZone
              item={characterItem}
              assetId={characterId || null}
              onDropAsset={handleCharacterDrop}
            />
            <ClipShowClipsDropZone
              clips={clipItems}
              onDropClip={handleClipDrop}
              onRemoveClip={handleClipRemove}
            />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem] gap-3">
            <label className="min-w-0">
              <span className="block text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 mb-1">Topic</span>
              <textarea
                value={showBrief}
                onChange={(e) => setShowBrief(e.target.value)}
                rows={2}
                placeholder="Immigration in the UK"
                className={cn(
                  'w-full min-h-[3.75rem] p-2.5 rounded bg-black/60 border border-emerald-500/25',
                  'text-sm font-mono text-emerald-200/90 resize-y',
                  'focus:outline-none focus:border-emerald-400/70',
                  'placeholder:text-emerald-300/30',
                )}
              />
            </label>
            <label className="min-w-0">
              <span className="block text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 mb-1">Host tone</span>
              <textarea
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                rows={2}
                className={cn(
                  'w-full min-h-[3.75rem] p-2.5 rounded bg-black/60 border border-zinc-700',
                  'text-[11px] font-mono text-emerald-300/90 resize-y',
                  'focus:outline-none focus:border-emerald-500/60',
                )}
              />
            </label>
          </div>
        </div>
      </section>

      {sidecar ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-800/60 pb-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/45">
              {sidecar.segments.length} clip{sidecar.segments.length === 1 ? '' : 's'} planned
            </div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/35">
              dialog -&gt; audio -&gt; first frame -&gt; video
            </div>
          </div>
          {sidecar.segments.map((segment, index) => (
            <ClipShowSegmentBlock
              key={`${segment.clip_asset_id}-${index}`}
              sidecar={sidecar}
              segment={segment}
              index={index}
              mediaItems={mediaItems}
              projectSlug={projectSlug}
              callTool={callTool}
              onSidecarUpdate={onSidecarUpdate}
            />
          ))}
        </div>
      ) : (
        <div className="rounded border border-dashed border-emerald-500/25 bg-zinc-950/40 p-6 text-center">
          <Mic className="w-6 h-6 mx-auto mb-2 text-emerald-300/40" />
          <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-300/45">
            drop a voiced char-* host and vid-* clips
          </div>
        </div>
      )}
    </div>
  );
}

function ClipShowCharacterDropZone({ item, assetId, onDropAsset }: {
  item: MediaItem | null;
  assetId: string | null;
  onDropAsset: (assetId: string) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      if (typeof payload.id === 'string') onDropAsset(payload.id);
    } catch {
      return;
    }
  };
  const src = item?.thumbnailSrc ?? item?.filePath ?? null;
  return (
    <div
      className={cn(
        'min-w-0 rounded border border-dashed p-3 transition-colors bg-black/35',
        dragActive ? 'border-emerald-300 bg-emerald-500/10' : 'border-emerald-500/25',
      )}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={handleDrop}
    >
      <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55 mb-2">Character</div>
      <div className="h-32 rounded bg-zinc-950/70 border border-zinc-800/70 flex items-center justify-center overflow-hidden">
        {src ? (
          <img src={src} alt={item?.slug ?? assetId ?? 'host'} className="w-full h-full object-contain" loading="lazy" />
        ) : (
          <Mic className="w-5 h-5 text-emerald-300/35" />
        )}
      </div>
      <div className="mt-2 text-[10px] font-mono text-emerald-200/75 truncate">
        {item?.slug ?? (assetId ? `@${assetId}` : 'drop char-* host')}
      </div>
    </div>
  );
}

function ClipShowClipsDropZone({ clips, onDropClip, onRemoveClip }: {
  clips: Array<{ id: string; item: MediaItem | null }>;
  onDropClip: (assetId: string) => void;
  onRemoveClip: (assetId: string) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      if (typeof payload.id === 'string') onDropClip(payload.id);
    } catch {
      return;
    }
  };
  return (
    <div
      className={cn(
        'min-w-0 rounded border border-dashed p-3 transition-colors bg-black/35',
        dragActive ? 'border-emerald-300 bg-emerald-500/10' : 'border-emerald-500/25',
      )}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">Clips</div>
        <div className="text-[10px] font-mono text-emerald-300/40">{clips.length > 0 ? `${clips.length} clip${clips.length === 1 ? '' : 's'}` : 'drop vid-* clips'}</div>
      </div>
      {clips.length === 0 ? (
        <div className="h-32 rounded bg-zinc-950/70 border border-zinc-800/70 flex flex-col items-center justify-center gap-1.5">
          <Film className="w-5 h-5 text-emerald-300/35" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/45">drop clips here</span>
        </div>
      ) : (
        <div className="flex min-h-32 flex-wrap gap-2">
          {clips.map(({ id, item }, index) => {
            const src = item?.thumbnailSrc ?? null;
            return (
              <div key={id} className="group relative w-36 rounded border border-zinc-700/60 bg-zinc-950/80 overflow-hidden">
                <div className="h-20 bg-black/40 flex items-center justify-center">
                  {src ? <img src={src} alt={item?.slug ?? id} className="w-full h-full object-contain" loading="lazy" /> : <Film className="w-4 h-4 text-emerald-300/40" />}
                </div>
                <div className="px-1.5 py-1">
                  <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/45">Clip {index + 1}</div>
                  <div className="text-[10px] font-mono text-emerald-200/75 truncate">{item?.slug ?? `@${id}`}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveClip(id)}
                  title="Remove clip"
                  className={cn(
                    'absolute top-1 right-1 h-5 w-5 rounded border border-zinc-700/70 bg-black/80',
                    'items-center justify-center text-emerald-300/60 hover:text-white hover:border-red-300/70 hover:bg-red-500/25',
                    'hidden group-hover:flex',
                  )}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          <div className="w-36 min-h-28 rounded border border-dashed border-zinc-700/70 bg-black/25 flex flex-col items-center justify-center gap-1 text-center px-2">
            <Film className="w-4 h-4 text-emerald-300/30" />
            <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/35">drop to add</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ClipShowAudioSlot({ state, assetId, generating, disabled, disabledReason, onGenerate, onReplace }: {
  state: AudioTileState;
  assetId: string | null;
  generating: boolean;
  disabled: boolean;
  disabledReason?: string;
  onGenerate: () => void;
  onReplace: (assetId: string) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const showSpinner = generating || state.kind === 'generating';
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      const droppedId = payload.id;
      if (typeof droppedId !== 'string') return;
      if (!droppedId.startsWith('aud-')) {
        toast({ title: 'Not an audio asset', description: `${droppedId} is not an aud-* asset.`, duration: 3000 });
        return;
      }
      if (droppedId === assetId) return;
      onReplace(droppedId);
    } catch {
      return;
    }
  };
  return (
    <div
      className={cn(
        'relative rounded border bg-zinc-950/60 min-h-[6.5rem] p-3 flex flex-col justify-center transition-colors',
        dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
      )}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={handleDrop}
    >
      {state.kind === 'ready' ? (
        <div className="min-w-0 space-y-2">
          <audio controls src={state.src} className="w-full min-w-0 h-8" />
          <button
            type="button"
            onClick={onGenerate}
            disabled={disabled || generating}
            title="Regenerate ElevenLabs audio"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-emerald-300/80 hover:text-emerald-300',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <RefreshCw className="w-3 h-3" />
            Regen
          </button>
        </div>
      ) : state.kind === 'error' ? (
        <div className="flex flex-col items-center justify-center gap-1.5 text-center">
          <span className="text-[10px] font-mono text-red-200/90 line-clamp-2">{state.message}</span>
          <button
            type="button"
            onClick={onGenerate}
            disabled={disabled}
            title="Retry ElevenLabs audio"
            className="h-6 px-2 flex items-center gap-1 rounded text-[10px] font-mono uppercase tracking-wider text-red-50 bg-red-500/30 hover:bg-red-500/50 border border-red-300/50"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onGenerate}
          disabled={disabled || showSpinner}
          title={disabled ? disabledReason : 'Generate ElevenLabs audio'}
          className="min-h-[5rem] flex flex-col items-center justify-center gap-1.5 hover:bg-emerald-500/5 rounded transition-colors disabled:cursor-not-allowed"
        >
          {showSpinner ? <Loader2 className="w-5 h-5 animate-spin text-emerald-300/80" /> : <Volume2 className="w-5 h-5 text-emerald-400/50" />}
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/50 px-3 text-center">
            {showSpinner ? 'generating audio...' : 'generate or drop audio'}
          </span>
        </button>
      )}
      {dragActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/30 pointer-events-none">
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-50 font-bold">drop audio</span>
        </div>
      )}
    </div>
  );
}

function ClipShowSegmentBlock({ sidecar, segment, index, mediaItems, projectSlug, callTool, onSidecarUpdate }: {
  sidecar: ClipShowPlanSidecar;
  segment: ClipShowSegment;
  index: number;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: ClipShowPlanSidecar) => void;
}) {
  const [dialog, setDialog] = useState(segment.dialog);
  const [firstFramePrompt, setFirstFramePrompt] = useState(segment.first_frame_prompt);
  const [videoPrompt, setVideoPrompt] = useState(segment.video_prompt);
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [generatingFrame, setGeneratingFrame] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const outputAspect = useMemo(() => sourceAspectFromDimensions(16, 9), []);
  const clipItem = useMemo(
    () => mediaItems.find((m) => m.id === segment.clip_asset_id) ?? null,
    [mediaItems, segment.clip_asset_id],
  );
  const audioState = useMemo(
    () => deriveClipShowAudioState(segment.audio_asset_id, mediaItems, projectSlug),
    [segment.audio_asset_id, mediaItems, projectSlug],
  );
  const frameState = useMemo(
    () => deriveStoryboardTileState(segment.first_frame_asset_id, mediaItems),
    [segment.first_frame_asset_id, mediaItems],
  );
  const videoState = useMemo(
    () => deriveClipShowVideoState(segment.video_asset_id, mediaItems, projectSlug),
    [segment.video_asset_id, mediaItems, projectSlug],
  );

  useEffect(() => {
    setDialog(segment.dialog);
    setFirstFramePrompt(segment.first_frame_prompt);
    setVideoPrompt(segment.video_prompt);
  }, [segment.dialog, segment.first_frame_prompt, segment.video_prompt]);

  const replaceSegment = useCallback(async (patch: Record<string, unknown>) => {
    const result = await callTool('replace_plan_clip_show_asset', {
      project_slug: projectSlug,
      segment_index: index,
      dialog,
      first_frame_prompt: firstFramePrompt,
      video_prompt: videoPrompt,
      ...patch,
    });
    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Plan update failed';
      toast({ title: 'Clip Show update failed', description: msg, duration: 5000 });
      return null;
    }
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { sidecar?: ClipShowPlanSidecar };
    if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
    return parsed.sidecar ?? null;
  }, [callTool, projectSlug, index, dialog, firstFramePrompt, videoPrompt, onSidecarUpdate]);

  const handleGenerateAudio = useCallback(async () => {
    if (!dialog.trim()) return;
    setGeneratingAudio(true);
    try {
      const saved = await replaceSegment({});
      if (!saved) return;
      const result = await callTool('generate_elevenlabs_t2a', {
        project_slug: projectSlug,
        character_asset_id: sidecar.character.asset_id,
        text: dialog.trim(),
        asset_name: `clip-show-s${index + 1}`,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'ElevenLabs generation failed';
        toast({ title: 'Audio generation failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { aud_asset_id?: string };
      if (parsed.aud_asset_id) await replaceSegment({ audio_asset_id: parsed.aud_asset_id });
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Audio enqueued', description: sidecar.character.elevenlabs_voice_id, duration: 2500 });
    } finally {
      setGeneratingAudio(false);
    }
  }, [dialog, replaceSegment, callTool, projectSlug, sidecar.character.asset_id, sidecar.character.elevenlabs_voice_id, index]);

  const handleGenerateFrame = useCallback(async () => {
    if (!firstFramePrompt.trim()) return;
    setGeneratingFrame(true);
    try {
      const saved = await replaceSegment({});
      if (!saved) return;
      const result = await callTool('generate_gpt_image', {
        project_slug: projectSlug,
        prompt: firstFramePrompt.trim(),
        image_slugs: [`@${sidecar.character.asset_id}`],
        aspect_ratio: '16:9',
        resolution: '2K',
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'First frame generation failed';
        toast({ title: 'First frame failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { img_asset_id?: string };
      if (parsed.img_asset_id) await replaceSegment({ first_frame_asset_id: parsed.img_asset_id });
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'First frame enqueued', description: 'GPT Image 2', duration: 2500 });
    } finally {
      setGeneratingFrame(false);
    }
  }, [firstFramePrompt, replaceSegment, callTool, projectSlug, sidecar.character.asset_id]);

  const handleGenerateVideo = useCallback(async () => {
    const firstFrameAssetId = segment.first_frame_asset_id;
    const audioAssetId = segment.audio_asset_id;
    if (!firstFrameAssetId || !audioAssetId) return;
    setGeneratingVideo(true);
    try {
      const saved = await replaceSegment({});
      if (!saved) return;
      const prompt = `${videoPrompt.trim()}\n\nSpoken dialog: ${dialog.trim()}`;
      const result = await callTool('generate_seedance2_video', {
        project_slug: projectSlug,
        first_frame_slug: `@${firstFrameAssetId}`,
        prompt,
        duration: String(sidecar.video_duration_s),
        resolution: sidecar.video_resolution,
        aspect_ratio: sidecar.video_aspect_ratio,
        generate_audio: false,
        replace_audio_with: `@${audioAssetId}`,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Seedance video generation failed';
        toast({ title: 'Video generation failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { vid_asset_id?: string };
      if (parsed.vid_asset_id) await replaceSegment({ video_asset_id: parsed.vid_asset_id });
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Seedance video enqueued', description: 'audio will be spliced after generation', duration: 2500 });
    } finally {
      setGeneratingVideo(false);
    }
  }, [segment.first_frame_asset_id, segment.audio_asset_id, replaceSegment, videoPrompt, dialog, callTool, projectSlug, sidecar.video_duration_s, sidecar.video_resolution, sidecar.video_aspect_ratio]);

  const handleAudioReplace = useCallback(async (assetId: string) => {
    await replaceSegment({ audio_asset_id: assetId });
  }, [replaceSegment]);

  const handleFrameReplace = useCallback(async (assetId: string) => {
    await replaceSegment({ first_frame_asset_id: assetId });
  }, [replaceSegment]);

  const handleVideoReplace = useCallback(async (assetId: string) => {
    await replaceSegment({ video_asset_id: assetId });
  }, [replaceSegment]);

  const canGenerateAudio = dialog.trim().length > 0 && !generatingAudio;
  const canGenerateVideo = audioState.kind === 'ready' && frameState.kind === 'ready' && !generatingVideo;
  const clipSrc = clipItem?.thumbnailSrc ?? null;
  const placementLabel = segment.placement === 'before' ? 'Intro' : segment.placement === 'after' ? 'Outro' : 'Intro + Outro';

  return (
    <section className="min-w-0 overflow-hidden rounded border border-emerald-500/20 bg-zinc-950/55">
      <header className="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-emerald-500/15 bg-black/45">
        <div className="min-w-0 flex items-center gap-2 font-mono">
          <span className="inline-flex w-6 h-6 shrink-0 items-center justify-center rounded-full border border-emerald-500/45 bg-emerald-500/10 text-emerald-200 text-[11px] font-bold">{index + 1}</span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-200 truncate">Clip {index + 1} {placementLabel}</h2>
            <div className="text-[10px] uppercase tracking-wider text-emerald-300/40 truncate">{clipItem?.slug ?? `@${segment.clip_asset_id}`}</div>
          </div>
        </div>
        <div className="text-[10px] font-mono text-emerald-300/45">GPT-5.5</div>
      </header>
      <div className="min-w-0 p-3 space-y-3">
        <div className="grid grid-cols-1 xl:grid-cols-[15rem_minmax(0,1fr)] gap-3">
          <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/60">Source clip</div>
              <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/35">{segment.placement}</div>
            </div>
            <div className="rounded border border-zinc-700/60 bg-black/40 overflow-hidden">
              <div className="h-28 flex items-center justify-center">
                {clipSrc ? <img src={clipSrc} alt={clipItem?.slug ?? segment.clip_asset_id} className="w-full h-full object-contain" loading="lazy" /> : <Film className="w-5 h-5 text-emerald-300/35" />}
              </div>
            </div>
            <div className="text-[10px] font-mono text-emerald-300/55 leading-relaxed line-clamp-5">{segment.clip_summary}</div>
          </div>

          <div className="min-w-0 grid grid-cols-1 lg:grid-cols-[repeat(2,minmax(0,1fr))] 2xl:grid-cols-[repeat(4,minmax(0,1fr))] gap-3">
            <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">Dialog</div>
                <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">edit</div>
              </div>
              <PromptEditor value={dialog} onChange={setDialog} mediaItems={mediaItems} projectSlug={projectSlug} />
            </div>

            <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">T2A audio</div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">dialog voiceover</div>
                </div>
              </div>
              <ClipShowAudioSlot
                state={audioState}
                assetId={segment.audio_asset_id ?? null}
                generating={generatingAudio}
                disabled={!canGenerateAudio}
                disabledReason="Dialog required"
                onGenerate={() => { void handleGenerateAudio(); }}
                onReplace={(assetId) => { void handleAudioReplace(assetId); }}
              />
            </div>

            <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">First frame</div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">prompt to image</div>
                </div>
              </div>
              <PromptEditor value={firstFramePrompt} onChange={setFirstFramePrompt} mediaItems={mediaItems} projectSlug={projectSlug} />
              <StoryboardImageSlot
                state={frameState}
                sourceAspect={outputAspect}
                assetId={segment.first_frame_asset_id ?? null}
                replacing={false}
                generating={generatingFrame}
                onIdleClick={() => { void handleGenerateFrame(); }}
                onReplace={(assetId) => { void handleFrameReplace(assetId); }}
                onErrorRetry={() => { void handleGenerateFrame(); }}
                onRegen={() => { void handleGenerateFrame(); }}
              />
            </div>

            <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">Final video</div>
                  <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">frame + audio</div>
                </div>
              </div>
              <PromptEditor value={videoPrompt} onChange={setVideoPrompt} mediaItems={mediaItems} projectSlug={projectSlug} />
              <VideoSwapSlot
                state={videoState}
                sourceAspect={outputAspect}
                videoAssetId={segment.video_asset_id ?? null}
                replacing={generatingVideo}
                disabled={!canGenerateVideo}
                disabledReason="Audio and first frame required"
                onIdleClick={() => { void handleGenerateVideo(); }}
                onReplace={(assetId) => { void handleVideoReplace(assetId); }}
                onErrorRetry={() => { void handleGenerateVideo(); }}
                onRegen={() => { void handleGenerateVideo(); }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function StoryboardDirectionPanel({ storyboardBrief, loopVideo, onBriefChange, onLoopChange }: {
  storyboardBrief: string;
  loopVideo: boolean;
  onBriefChange: (next: string) => void;
  onLoopChange: (next: boolean) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_7.75rem] gap-3 items-start">
      <label className="min-w-0">
        <span className="block text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 mb-1">Storyboard direction</span>
        <textarea
          value={storyboardBrief}
          onChange={(e) => onBriefChange(e.target.value)}
          rows={3}
          placeholder="Bangkok confidence walk, rainy neon chase, product reveal..."
          className={cn(
            'w-full min-h-[4.75rem] p-2 rounded bg-black/60 border border-zinc-700',
            'text-[11px] font-mono text-emerald-300/90 resize-y',
            'focus:outline-none focus:border-emerald-500/60',
            'placeholder:text-emerald-300/30',
          )}
        />
      </label>
      <div className="min-w-0">
        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 mb-1">Loop</div>
        <button
          type="button"
          role="switch"
          aria-checked={loopVideo}
          onClick={() => onLoopChange(!loopVideo)}
          title={loopVideo ? 'Loop enabled' : 'Loop disabled'}
          className={cn(
            'h-8 w-full px-2 flex items-center justify-between gap-2 rounded border transition-colors',
            loopVideo
              ? 'bg-emerald-500/15 border-emerald-500/55 text-emerald-200'
              : 'bg-black/60 border-zinc-700 text-emerald-300/55 hover:border-emerald-500/40 hover:text-emerald-300/80',
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider">
            <RefreshCw className="w-3 h-3" />
            {loopVideo ? 'On' : 'Off'}
          </span>
          <span
            className={cn(
              'relative h-4 w-8 shrink-0 overflow-hidden rounded-full border transition-colors',
              loopVideo ? 'border-emerald-300/70 bg-emerald-300/20' : 'border-zinc-600 bg-zinc-950',
            )}
          >
            <span
              className={cn(
                'absolute left-0.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-transform',
                loopVideo ? 'translate-x-4 bg-emerald-200' : 'translate-x-0 bg-zinc-500',
              )}
            />
          </span>
        </button>
      </div>
    </div>
  );
}

function StoryboardSourceDropZone({ sources, onDropSource, onRemoveSource, onPromoteSource }: {
  sources: Array<{
    id: string;
    src: string | null;
    label: string;
    aspect: SourceAspect;
  }>;
  onDropSource: (assetId: string) => void;
  onRemoveSource: (assetId: string) => void;
  onPromoteSource: (assetId: string) => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      if (typeof payload.id === 'string') onDropSource(payload.id);
    } catch {
      return;
    }
  };
  return (
    <div
      className={cn(
        'rounded border border-dashed p-3 transition-colors',
        dragActive ? 'border-emerald-300 bg-emerald-500/10' : 'border-zinc-700/70 bg-zinc-950/40',
      )}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={handleDrop}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 mb-1">Source images</div>
          <div className="text-[10px] font-mono text-emerald-300/40">
            {sources.length > 0 ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : 'drop img-* references'}
          </div>
        </div>
        {sources.length === 0 ? (
          <div className="h-28 rounded bg-black/35 border border-zinc-800/70 flex flex-col items-center justify-center gap-1.5">
            <Images className="w-5 h-5 text-emerald-300/35" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/45">drop one or more source images</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sources.map((source, index) => (
              <div key={source.id} className="group relative w-28 rounded border border-zinc-700/60 bg-zinc-900 overflow-hidden">
                <button
                  type="button"
                  onClick={() => onPromoteSource(source.id)}
                  disabled={index === 0}
                  title={index === 0 ? 'Primary source image' : 'Make primary source'}
                  className="block w-full"
                >
                  <div className="bg-black/40 flex items-center justify-center" style={{ aspectRatio: source.aspect.css }}>
                    {source.src ? (
                      <img src={source.src} alt={source.label} className="w-full h-full object-contain" loading="lazy" />
                    ) : (
                      <Images className="w-4 h-4 text-emerald-300/40" />
                    )}
                  </div>
                  <div className="px-1.5 py-1 text-left">
                    <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/45">
                      {index === 0 ? 'Primary' : `Source ${index + 1}`}
                    </div>
                    <div className="text-[10px] font-mono text-emerald-200/75 truncate">{source.label}</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveSource(source.id)}
                  title="Remove source image"
                  className={cn(
                    'absolute top-1 right-1 h-5 w-5 rounded border border-zinc-700/70 bg-black/80',
                    'items-center justify-center text-emerald-300/60 hover:text-white hover:border-red-300/70 hover:bg-red-500/25',
                    'hidden group-hover:flex',
                  )}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="w-28 rounded border border-dashed border-zinc-700/70 bg-black/25 flex flex-col items-center justify-center gap-1 text-center px-2">
              <Images className="w-4 h-4 text-emerald-300/30" />
              <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/35">drop to add</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StoryboardImageSlot({ state, sourceAspect, assetId, replacing, generating, onReplace, onIdleClick, onErrorRetry, onRegen }: {
  state: FrameTileState;
  sourceAspect: SourceAspect;
  assetId: string | null;
  replacing: boolean;
  generating: boolean;
  onReplace: (assetId: string) => void;
  onIdleClick: () => void;
  onErrorRetry?: () => void;
  onRegen: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const showSpinner = state.kind === 'generating' || replacing || generating;
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      const droppedId = payload.id;
      if (typeof droppedId !== 'string') return;
      if (!droppedId.startsWith('img-')) {
        toast({ title: 'Not an image asset', description: `${droppedId} is not an img-* asset.`, duration: 3000 });
        return;
      }
      if (droppedId === assetId) return;
      onReplace(droppedId);
    } catch {
      return;
    }
  };
  return (
    <div
      className={cn(
        'relative self-start w-full bg-zinc-900 border rounded overflow-hidden flex items-center justify-center group transition-colors',
        dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
      )}
      style={{ aspectRatio: sourceAspect.css }}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false); }}
      onDrop={handleDrop}
    >
      {state.kind === 'ready' ? (
        <img src={state.src} alt="storyboard result" className="w-full h-full object-contain" loading="lazy" />
      ) : state.kind === 'idle' && !showSpinner ? (
        <button
          type="button"
          onClick={onIdleClick}
          title="Click to generate storyboard or drop an img-* storyboard"
          className="w-full h-full flex flex-col items-center justify-center gap-1.5 hover:bg-emerald-500/5 transition-colors cursor-pointer"
        >
          <Images className="w-5 h-5 text-emerald-400/50 group-hover:text-emerald-300/80" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/50 group-hover:text-emerald-300/80 px-3 text-center">
            click to generate or drop storyboard
          </span>
        </button>
      ) : (
        <div className="w-full h-full bg-black/60" />
      )}
      {showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-300/80" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/70">
            {replacing ? 'updating...' : 'generating...'}
          </span>
        </div>
      )}
      {state.kind === 'error' && !showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-red-950/70 px-3">
          <span className="text-[10px] font-mono text-red-200/90 text-center line-clamp-3">{state.message}</span>
          {onErrorRetry && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onErrorRetry(); }}
              title="Re-run the storyboard generation"
              className={cn(
                'h-6 px-2 flex items-center gap-1 rounded',
                'text-[10px] font-mono uppercase tracking-wider',
                'text-red-50 hover:text-white',
                'bg-red-500/30 hover:bg-red-500/50 border border-red-300/50 hover:border-red-200/80',
              )}
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          )}
        </div>
      )}
      {state.kind === 'ready' && !showSpinner && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 px-1.5 py-1 bg-gradient-to-t from-black/90 via-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRegen(); }}
            title="Regenerate the storyboard with the current prompt"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-emerald-300/80 hover:text-emerald-300',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
            )}
          >
            <RefreshCw className="w-3 h-3" />
            Regen
          </button>
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

type SwapModel = 'nano-banana-pro' | 'gpt-image-2' | 'wan-2-7-image-pro';
type SwapProvider = 'kie' | 'fal';

const ALL_SWAP_MODELS: SwapModel[] = ['nano-banana-pro', 'gpt-image-2', 'wan-2-7-image-pro'];
const ALL_SWAP_PROVIDERS: SwapProvider[] = ['kie', 'fal'];

// Mirror of server SUPPORTED_MODELS_BY_PROVIDER: fal doesn't host gpt-image-2.
const MODELS_BY_PROVIDER: Record<SwapProvider, SwapModel[]> = {
  kie: ['nano-banana-pro', 'gpt-image-2', 'wan-2-7-image-pro'],
  fal: ['nano-banana-pro', 'wan-2-7-image-pro'],
};

const SHORT_LABEL_BY_MODEL: Record<SwapModel, string> = {
  'nano-banana-pro': 'nbp',
  'gpt-image-2': 'gi2',
  'wan-2-7-image-pro': 'wan',
};

// Variant key used in scene.swap.image{N}_variants. Bare model name = kie
// (preserves backward compat with older plans). `fal:{model}` = fal variant.
function variantKey(provider: SwapProvider, model: SwapModel): string {
  return provider === 'fal' ? `fal:${model}` : model;
}

function parseVariantKey(key: string): { provider: SwapProvider; model: SwapModel } | null {
  const falPrefix = 'fal:';
  if (key.startsWith(falPrefix)) {
    const m = key.slice(falPrefix.length);
    if ((ALL_SWAP_MODELS as readonly string[]).includes(m)) {
      return { provider: 'fal', model: m as SwapModel };
    }
    return null;
  }
  if ((ALL_SWAP_MODELS as readonly string[]).includes(key)) {
    return { provider: 'kie', model: key as SwapModel };
  }
  return null;
}

type VideoModel = 'seedance-2-ref' | 'seedance-2-fast';

const ALL_VIDEO_MODELS: VideoModel[] = ['seedance-2-ref', 'seedance-2-fast'];
const STORYBOARD_VIDEO_MODELS: VideoModel[] = ['seedance-2-ref', 'seedance-2-fast'];

const TOOL_BY_VIDEO_MODEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'generate_seedance2_video',
  'seedance-2-fast': 'generate_seedance2_fast_video',
};

const LABEL_BY_VIDEO_MODEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'Seedance 2',
  'seedance-2-fast': 'Seedance Fast',
};

// Per-scene clip + audio live as sibling files inside the `plan` asset
// (stamped into `.plan.json` by /plan-vis as `clip_filename` / `audio_filename`,
// e.g. "s1.mp4" / "s1.mp3"). The render path addresses them via the
// `@plan/<filename>` slug form the seedance/kie resolvers learned.
const PLAN_ASSET_ID = 'plan';

interface SceneAssetSlugs {
  clipSlug: string;  // e.g. "plan/s1.mp4"
  audioSlug: string; // e.g. "plan/s1.mp3"
}

function PlanScenes({ data, mediaItems, sourceAspect, projectSlug, callTool, dispatch, onSidecarUpdate }: {
  data: PlanSidecar;
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  dispatch: (input: string) => Promise<boolean>;
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}) {
  // Old plans (pre destination-mode plan-vis) have no per-scene clip/audio
  // filenames. The render path can't address them, so prompt a re-run instead
  // of half-rendering.
  const planNeedsRegen = data.scenes.length > 0
    && (!data.scenes[0].clip_filename || !data.scenes[0].audio_filename);

  // Per-scene slugs derived directly from the sidecar — no ID reconciliation.
  // `plan/sN.mp4` and `plan/sN.mp3` resolve via the @assetId/filename slug
  // form the seedance/kie resolvers learned.
  const sceneAssets: SceneAssetSlugs[] = useMemo(
    () => data.scenes.map((s) => ({
      clipSlug: `${PLAN_ASSET_ID}/${s.clip_filename ?? ''}`,
      audioSlug: `${PLAN_ASSET_ID}/${s.audio_filename ?? ''}`,
    })),
    [data.scenes],
  );

  // Tracks whether all per-scene clip/audio files exist on disk. Flips to
  // true after the bootstrap effect successfully observes (or writes) every
  // sN.mp4 / sN.mp3. Drives the RUN VIDEO gate per scene; otherwise seedance
  // would receive a half-written reference.
  const [sceneFilesReady, setSceneFilesReady] = useState(false);

  // Bootstrap once per (project, source). Two phases:
  //   1. read the plan asset's manifest to see which sN.mp4 / sN.mp3 already
  //      exist; if any clip is missing, fire one even_split with destination
  //      writing all sN.mp4 into plan/.
  //   2. for each missing sN.mp3, fire extract_audio with destination
  //      pointing at the same plan asset (sequential — git mutex serialises
  //      committing siblings into the same asset).
  const splitBootstrapKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (planNeedsRegen) return;
    const key = `${projectSlug}/${data.source_asset_id}`;
    if (splitBootstrapKeyRef.current === key) return;
    const sceneCount = data.scenes.length;
    splitBootstrapKeyRef.current = key;
    if (sceneCount === 0) return;
    void (async () => {
      // Reset readiness up-front in case we're switching plans mid-session.
      // Doing it inside the async closure keeps the synchronous effect body
      // setState-free (react-hooks/set-state-in-effect).
      setSceneFilesReady(false);
      const manifestResult = await callTool('asset_manifest', {
        project_slug: projectSlug,
        asset_id: PLAN_ASSET_ID,
      });
      let presentNames = new Set<string>();
      if (!manifestResult.isError) {
        try {
          const text = (manifestResult.content as Array<{ type: string; text: string }>)[0].text;
          const parsed = JSON.parse(text) as { files?: Array<{ name: string }> };
          presentNames = new Set((parsed.files ?? []).map((f) => f.name));
        } catch {
          // Treat as empty — bootstrap will try to write everything. Server
          // refuses overwrite, so any partial state surfaces as a toast below.
        }
      }

      const missingClips = data.scenes
        .map((s, i) => ({ scene: s, index: i }))
        .filter(({ scene }) => scene.clip_filename && !presentNames.has(scene.clip_filename));

      if (missingClips.length > 0) {
        // even_split's destination mode writes all chunks into the plan asset
        // in one job + one commit. We pass the full ordered filename list
        // (server requires filenames.length === target_secs.length) and only
        // fire if any clip is missing — destination mode rejects overwrites,
        // so partial states need a manual fix first.
        if (missingClips.length !== sceneCount) {
          toast({
            title: 'Plan clips partially present',
            description: `${sceneCount - missingClips.length}/${sceneCount} clips already on disk. Delete the partial set or re-run /plan-vis.`,
            duration: 6000,
          });
        } else {
          const splitResult = await callTool('even_split', {
            project_slug: projectSlug,
            asset_id: data.source_asset_id,
            target_secs: data.scenes.map((s) => s.end - s.start),
            destination: {
              asset_id: PLAN_ASSET_ID,
              filenames: data.scenes.map((s) => s.clip_filename!),
            },
          });
          if (splitResult.isError) {
            const msg = (splitResult.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'even_split failed';
            toast({ title: 'Source clip split failed', description: msg, duration: 5000 });
            return;
          }
          // Re-read manifest so the audio phase sees the new clips.
          try {
            const refreshed = await callTool('asset_manifest', {
              project_slug: projectSlug,
              asset_id: PLAN_ASSET_ID,
            });
            if (!refreshed.isError) {
              const text = (refreshed.content as Array<{ type: string; text: string }>)[0].text;
              const parsed = JSON.parse(text) as { files?: Array<{ name: string }> };
              presentNames = new Set((parsed.files ?? []).map((f) => f.name));
            }
          } catch {
            // Fall through; the for-loop below tries each scene anyway.
          }
        }
      }

      let allAudioOk = true;
      for (const scene of data.scenes) {
        if (!scene.audio_filename) { allAudioOk = false; continue; }
        if (presentNames.has(scene.audio_filename)) continue;
        const audResult = await callTool('extract_audio', {
          project_slug: projectSlug,
          asset_id: data.source_asset_id,
          destination: {
            asset_id: PLAN_ASSET_ID,
            filename: scene.audio_filename,
          },
          // Clip just this scene's window so the resulting mp3 stays under
          // seedance-2's 15.2s reference cap. Without this the full source
          // audio lands in plan/sN.mp3 and seedance rejects the call.
          range: {
            start_s: scene.start,
            duration_s: scene.end - scene.start,
          },
        });
        if (audResult.isError) {
          allAudioOk = false;
          const msg = (audResult.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'extract_audio failed';
          toast({ title: `Audio extract failed for ${scene.audio_filename}`, description: msg, duration: 5000 });
        }
      }
      // Both even_split (enqueueAndWait) and extract_audio destination mode
      // (enqueueAndWait) return only after their files land, so by here the
      // mp4s + mp3s exist on disk. Flip the gate.
      const allClipsOk = data.scenes.every((s) => s.clip_filename);
      if (allClipsOk && allAudioOk) setSceneFilesReady(true);
    })();
  }, [projectSlug, data.source_asset_id, data.scenes, callTool, planNeedsRegen]);

  if (planNeedsRegen) {
    return (
      <div className="mt-5 rounded border border-amber-600/40 bg-amber-950/20 p-4 text-amber-200 text-sm">
        This plan was generated by an older version of /plan-vis and is missing per-scene
        clip/audio filenames. Re-run <span className="font-mono">/plan-vis</span> to enable
        rendering.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {data.scenes.map((scene, idx) => (
        <SceneBlock
          key={`${scene.start}-${scene.end}-${idx}`}
          scene={scene}
          index={idx}
          sceneCount={data.scenes.length}
          characters={data.characters}
          sceneClipSlug={sceneAssets[idx]?.clipSlug ?? null}
          sceneAudioSlug={sceneAssets[idx]?.audioSlug ?? null}
          sceneSourceReady={sceneFilesReady}
          mediaItems={mediaItems}
          sourceAspect={sourceAspect}
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
  | { kind: 'ready'; src: string }
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
    if (src) return { kind: 'ready', src };
    return { kind: 'generating' };
  }
  return { kind: 'generating' };
}

// Extract the short model code from an auto-generated swap slug like
// `img-nbp-s1-1` or `img-gi2-fal-s2-2`. Returns the code with optional `-fal`
// suffix, or null for manual-upload assets and pre-rename legacy slugs.
// Tail `(?:-\d+)*` tolerates collision-suffixed slugs from createAsset.
function modelCodeFromSwapAssetId(assetId: string | null | undefined): string | null {
  if (!assetId) return null;
  const m = /^img-((?:nbp|gi2|wan)(?:-fal)?)-s\d+-\d+(?:-\d+)*$/.exec(assetId);
  return m ? m[1] : null;
}

function SourceSlotRow({ sourceSrc, sourceAspect, state, inFlightCodes, currentModelCode, label, replacing, onReplace, onIdleClick, onErrorRetry, onRegen }: {
  sourceSrc: string;
  sourceAspect: SourceAspect;
  state: FrameTileState;
  inFlightCodes: string[];
  currentModelCode: string | null;
  label: string;
  replacing: boolean;
  onReplace: (source: ReplaceSource) => void;
  onIdleClick: () => void;
  onErrorRetry?: () => void;
  onRegen: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <SourceThumb src={sourceSrc} sourceAspect={sourceAspect} alt={`source ${label}`} />
        <span className="text-emerald-300/40 text-lg leading-none px-0.5 select-none">→</span>
        <SwapSlot
          state={state}
          sourceSrc={sourceSrc}
          sourceAspect={sourceAspect}
          inFlightCodes={inFlightCodes}
          currentModelCode={currentModelCode}
          replacing={replacing}
          onReplace={onReplace}
          onIdleClick={onIdleClick}
          onErrorRetry={onErrorRetry}
          onRegen={onRegen}
        />
      </div>
      <div className="text-[10px] font-mono text-emerald-300/50">{label}</div>
    </div>
  );
}

function SourceThumb({ src, sourceAspect, alt }: { src: string; sourceAspect: SourceAspect; alt: string }) {
  const [errored, setErrored] = useState(false);
  return (
    <div
      className="w-40 bg-zinc-900 border border-zinc-700/40 rounded overflow-hidden flex items-center justify-center"
      style={{ aspectRatio: sourceAspect.css }}
    >
      {errored ? (
        <span className="text-[9px] font-mono text-emerald-300/30 px-2 text-center">missing</span>
      ) : (
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-contain opacity-80"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

function SwapSlot({ state, sourceSrc, sourceAspect, inFlightCodes, currentModelCode, replacing, onReplace, onIdleClick, onErrorRetry, onRegen }: {
  state: FrameTileState;
  sourceSrc: string;
  sourceAspect: SourceAspect;
  inFlightCodes: string[];
  currentModelCode: string | null;
  replacing: boolean;
  onReplace: (source: ReplaceSource) => void;
  onIdleClick: () => void;
  onErrorRetry?: () => void;
  onRegen?: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const anyInFlight = inFlightCodes.length > 0;
  const showSpinner = state.kind === 'generating' || replacing || (anyInFlight && state.kind === 'idle');
  // Caption inside the spinner overlay so the user knows what's running.
  // Prefers the currently-selected slot's code (whose asset is in 'generating'
  // status) and otherwise lists any in-flight code submissions.
  const spinnerLabel = (() => {
    if (replacing) return 'uploading…';
    if (state.kind === 'generating' && currentModelCode) {
      return `${currentModelCode}…`;
    }
    if (inFlightCodes.length > 0) {
      return inFlightCodes.join(', ');
    }
    return null;
  })();
  const showReadyActions = state.kind === 'ready' && !replacing;
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
        'relative w-40 bg-zinc-900 border rounded overflow-hidden flex items-center justify-center group transition-colors',
        dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
      )}
      style={{ aspectRatio: sourceAspect.css }}
      onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
      onDrop={handleDrop}
    >
      {state.kind === 'ready' ? (
        <img src={state.src} alt="swap result" className="w-full h-full object-contain" loading="lazy" />
      ) : state.kind === 'idle' && !anyInFlight ? (
        <button
          type="button"
          onClick={onIdleClick}
          title="Click to pick models and generate · or drop an image"
          className="w-full h-full flex items-center justify-center hover:bg-emerald-500/5 transition-colors cursor-pointer"
        >
          <span className="text-[10px] font-mono text-emerald-300/40 group-hover:text-emerald-300/70 px-2 text-center">click to generate · or drop image</span>
        </button>
      ) : !errored ? (
        <img
          src={sourceSrc}
          alt="working"
          className="w-full h-full object-contain opacity-40"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      ) : (
        <span className="text-[10px] font-mono text-emerald-300/40 px-2 text-center">missing</span>
      )}
      {showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-300/80" />
          {spinnerLabel && (
            <span className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/70 px-2 text-center line-clamp-2">
              {spinnerLabel}
            </span>
          )}
          {onRegen && state.kind === 'generating' && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRegen(); }}
              title="Re-fire this swap (use if generation is stuck)"
              className={cn(
                'absolute top-1 right-1',
                'h-5 px-1.5 flex items-center gap-1 rounded',
                'text-[9px] font-mono uppercase tracking-wider',
                'text-emerald-300/80 hover:text-emerald-300',
                'bg-black/60 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
              )}
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Retry
            </button>
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
      {showReadyActions && onRegen && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 px-1.5 py-1 bg-gradient-to-t from-black/90 via-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRegen(); }}
            title="Re-generate with the current provider, model, and prompt"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-emerald-300/80 hover:text-emerald-300',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
            )}
          >
            <RefreshCw className="w-3 h-3" />
            Regen
          </button>
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

type VideoTileState =
  | { kind: 'idle' }
  | { kind: 'generating'; label?: string }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

function deriveVideoTileState(scene: PlanScene, mediaItems: MediaItem[], projectSlug: string): VideoTileState {
  const vidId = scene.swap?.video;
  if (!vidId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === vidId);
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'video gen failed' };
  if (item.status === 'ready') {
    const src = `/files/${projectSlug}/${vidId}/original.mp4`;
    return { kind: 'ready', src };
  }
  // 'generating', 'replacing-audio', etc.
  const label = item.status === 'replacing-audio' ? 'splicing audio…' : 'generating…';
  return { kind: 'generating', label };
}

function VideoSwapSlot({
  state,
  sourceAspect,
  videoAssetId,
  replacing,
  disabled,
  disabledReason,
  onReplace,
  onIdleClick,
  onErrorRetry,
  onRegen,
}: {
  state: VideoTileState;
  sourceAspect: SourceAspect;
  videoAssetId: string | null;
  replacing: boolean;
  disabled: boolean;
  disabledReason?: string;
  onReplace: (videoAssetId: string) => void;
  onIdleClick: () => void;
  onErrorRetry?: () => void;
  onRegen: () => void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const showSpinner = state.kind === 'generating' || replacing;
  const spinnerLabel = (() => {
    if (replacing) return 'updating…';
    if (state.kind === 'generating' && state.label) return state.label;
    return null;
  })();
  const showReadyActions = state.kind === 'ready' && !replacing;

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      const droppedId = payload.id;
      if (typeof droppedId !== 'string') return;
      if (!droppedId.startsWith('vid-')) {
        toast({ title: 'Not a video asset', description: `${droppedId} is not a vid-* asset.`, duration: 3000 });
        return;
      }
      if (droppedId === videoAssetId) return;
      onReplace(droppedId);
    } catch {
      // Malformed payload — ignore.
    }
  };

  return (
    <div
      className={cn(
        'relative self-start max-w-md w-full bg-zinc-900 border rounded overflow-hidden flex items-center justify-center group transition-colors',
        dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
        disabled && state.kind === 'idle' && 'opacity-50',
      )}
      style={{ aspectRatio: sourceAspect.css }}
      onDragEnter={(e) => { if (!e.dataTransfer.types.includes('application/x-videocity-asset-video')) return; e.preventDefault(); setDragActive(true); }}
      onDragOver={(e) => { if (!e.dataTransfer.types.includes('application/x-videocity-asset-video')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false); }}
      onDrop={handleDrop}
    >
      {state.kind === 'ready' ? (
        <video
          key={videoAssetId ?? 'no-video'}
          controls
          src={state.src}
          className="w-full h-full object-contain bg-black"
        />
      ) : state.kind === 'idle' ? (
        <button
          type="button"
          onClick={onIdleClick}
          disabled={disabled}
          title={disabled ? disabledReason : 'Click to generate scene video · or drop a video clip'}
          className="w-full h-full flex flex-col items-center justify-center gap-1.5 hover:bg-emerald-500/5 transition-colors cursor-pointer disabled:cursor-not-allowed"
        >
          <Film className="w-5 h-5 text-emerald-400/50 group-hover:text-emerald-300/80" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400/50 group-hover:text-emerald-300/80 px-3 text-center">
            click to generate · or drop video
          </span>
        </button>
      ) : (
        <div className="w-full h-full bg-black/60" />
      )}

      {showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-300/80" />
          {spinnerLabel && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/70">
              {spinnerLabel}
            </span>
          )}
          {state.kind === 'generating' && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRegen(); }}
              title="Re-fire this video gen (use if it's stuck)"
              className={cn(
                'absolute top-1 right-1',
                'h-5 px-1.5 flex items-center gap-1 rounded',
                'text-[9px] font-mono uppercase tracking-wider',
                'text-emerald-300/80 hover:text-emerald-300',
                'bg-black/60 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
              )}
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Retry
            </button>
          )}
        </div>
      )}

      {state.kind === 'error' && !showSpinner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-red-950/70 px-3">
          <span className="text-[10px] font-mono text-red-200/90 text-center line-clamp-3">{state.message}</span>
          {onErrorRetry && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onErrorRetry(); }}
              title="Re-run the video generation"
              className={cn(
                'h-6 px-2 flex items-center gap-1 rounded',
                'text-[10px] font-mono uppercase tracking-wider',
                'text-red-50 hover:text-white',
                'bg-red-500/30 hover:bg-red-500/50 border border-red-300/50 hover:border-red-200/80',
              )}
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          )}
        </div>
      )}

      {showReadyActions && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 px-1.5 py-1 bg-gradient-to-t from-black/90 via-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRegen(); }}
            title="Regenerate the scene video with the current model + prompt"
            className={cn(
              'h-6 px-2 flex items-center gap-1 rounded',
              'text-[10px] font-mono uppercase tracking-wider',
              'text-emerald-300/80 hover:text-emerald-300',
              'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
            )}
          >
            <RefreshCw className="w-3 h-3" />
            Regen
          </button>
        </div>
      )}

      {dragActive && !replacing && (
        <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/30 pointer-events-none">
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-50 font-bold">DROP TO REPLACE</span>
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

// Frame 2 prompt — used when generating the last frame and a previously
// swapped first frame is available. Inputs are [source last frame, char A,
// char B, prior image1 swap]. Char refs drive identity; Image 4 is only a
// look-continuity reference (face/hair/wardrobe/color grade).
const DEFAULT_PROMPT_FRAME2_PRIOR_SWAP = "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Image 4 shows how those same two people appeared in the prior frame of this scene — match their look (face, hair, wardrobe, color grade) to Image 4 exactly so the two frames feel continuous. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.";

// Build a stable empty prompts map keyed by every (provider, model) combo.
// Frame 2 seeds with the prior-swap continuity prompt (mentions Image 4);
// frame 1 seeds with the per-model char-swap default.
function makeEmptyModelPrompts(frameIndex: 1 | 2): Record<string, string> {
  const out: Record<string, string> = {};
  for (const provider of ALL_SWAP_PROVIDERS) {
    for (const model of MODELS_BY_PROVIDER[provider]) {
      out[variantKey(provider, model)] = frameIndex === 2
        ? DEFAULT_PROMPT_FRAME2_PRIOR_SWAP
        : DEFAULT_PROMPT_BY_SWAP_MODEL[model];
    }
  }
  return out;
}

// Mirrors what server/src/payload-builders.ts produces for the corresponding
// `generate_*_image` tools, but in slug form (no URL resolution). Keep aligned
// with the swap-plan-scene-frame queue payload and the per-model `input`
// shapes from @apicity/kie's model-schemas.
const KIE_MODEL_NAME_BY_SWAP: Record<SwapModel, string> = {
  'nano-banana-pro': 'nano-banana-pro',
  'gpt-image-2': 'gpt-image-2-image-to-image',
  'wan-2-7-image-pro': 'wan/2-7-image-pro',
};

// Fal endpoint ids that the server's swap dispatch routes to (see
// server/src/jobs/generate-{nano-banana-pro,wan27-pro}-edit-fal.ts).
const FAL_ENDPOINT_BY_SWAP: Partial<Record<SwapModel, string>> = {
  'nano-banana-pro': 'fal-ai/nano-banana-pro/edit',
  'wan-2-7-image-pro': 'fal-ai/wan/v2.7/pro/edit',
};

function buildSwapPayload(
  provider: SwapProvider,
  model: SwapModel,
  characters: PlanSidecar['characters'],
  sceneIndex: number,
  frameIndex: 1 | 2,
  customPrompt: string,
  sourceAspect: SourceAspect,
  priorSwapAssetId?: string,
): { provider: SwapProvider; endpoint: string; input: Record<string, unknown> } {
  const sourceFrameSlug = `@plan/s${sceneIndex + 1}-image${frameIndex}-source.jpg`;
  // 4-image input when priorSwapAssetId is set (frame 2 against an
  // already-swapped frame 1): [source, char A, char B, prior swap].
  // Mirrors the server's priorPushed branch in swap-plan-scene-frame.ts.
  const inputs = [
    sourceFrameSlug,
    ...characters.map((c) => `@${c.asset_id}`),
    ...(priorSwapAssetId ? [`@${priorSwapAssetId}`] : []),
  ];
  const trimmed = customPrompt.trim();
  const defaultPrompt = priorSwapAssetId
    ? DEFAULT_PROMPT_FRAME2_PRIOR_SWAP
    : DEFAULT_PROMPT_BY_SWAP_MODEL[model];
  const prompt = trimmed.length > 0 ? trimmed : defaultPrompt;
  const imageAspectRatio = kieImageAspectRatioForDimensions(model, sourceAspect.width, sourceAspect.height);
  if (provider === 'fal') {
    const endpoint = FAL_ENDPOINT_BY_SWAP[model];
    if (!endpoint) {
      // gpt-image-2 isn't on Fal — surface a placeholder payload so the JSON
      // tab still renders something rather than crashing.
      return { provider, endpoint: `(no fal endpoint for ${model})`, input: { prompt, image_urls: inputs } };
    }
    if (model === 'wan-2-7-image-pro') {
      return {
        provider,
        endpoint,
        input: { prompt, image_urls: inputs, image_size: falWanImageSizeForDimensions(sourceAspect.width, sourceAspect.height) },
      };
    }
    return {
      provider,
      endpoint,
      input: { prompt, image_urls: inputs, aspect_ratio: imageAspectRatio, resolution: '2K' },
    };
  }
  const inputKey = model === 'nano-banana-pro' ? 'image_input' : 'input_urls';
  return {
    provider,
    endpoint: KIE_MODEL_NAME_BY_SWAP[model],
    input: {
      prompt,
      [inputKey]: inputs,
      aspect_ratio: imageAspectRatio,
      resolution: model === 'gpt-image-2' ? '4K' : '2K',
    },
  };
}

// Per-frame block: provider/model dropdowns, prompt/JSON tabs (chip-aware
// prompt view), and the source→slot row. Each frame is a self-contained unit;
// idle slot click runs only the selected (provider, model) for THAT frame.
function FrameImagePanel({ provider, onProviderChange, model, onModelChange, prompt, onPromptChange, payload, mediaItems, projectSlug }: {
  provider: SwapProvider;
  onProviderChange: (next: SwapProvider) => void;
  model: SwapModel;
  onModelChange: (next: SwapModel) => void;
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
  const allowedModels = MODELS_BY_PROVIDER[provider];
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono">
        <ProviderModelSelect
          label="Provider"
          value={provider}
          options={ALL_SWAP_PROVIDERS}
          onChange={(next) => onProviderChange(next as SwapProvider)}
        />
        <ProviderModelSelect
          label="Model"
          value={model}
          options={allowedModels}
          onChange={(next) => onModelChange(next as SwapModel)}
        />
      </div>
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
              'text-emerald-300/70 hover:text-emerald-300',
              'bg-emerald-500/5 hover:bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40',
              'transition-colors duration-150',
            )}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {view === 'prompt' ? (
        <PromptEditor
          value={prompt}
          onChange={onPromptChange}
          mediaItems={mediaItems}
          projectSlug={projectSlug}
        />
      ) : (
        <PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />
      )}
    </div>
  );
}

function ProviderModelSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-emerald-300/50 uppercase tracking-wider">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-6 px-1.5 rounded bg-black/60 border border-zinc-700 text-emerald-300/90',
          'focus:outline-none focus:border-emerald-500/60 cursor-pointer',
        )}
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
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

// "Both swaps present" gate. Slot-presence is the new accepted: a swap that's
// landed in the slot counts; a missing or in-flight swap blocks RUN VIDEO.
// Char-refs-only mode (no swap on either side) is also fine.
function videoReadyForGen(
  scene: PlanScene,
  tile1: FrameTileState,
  tile2: FrameTileState,
): { ok: boolean; reason?: string } {
  const hasAny = !!(scene.swap?.image1 || scene.swap?.image2);
  if (!hasAny) return { ok: true };
  if (tile1.kind === 'ready' && tile2.kind === 'ready') return { ok: true };
  return { ok: false, reason: 'Both swap frames must finish generating' };
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
  sceneClipSlug: string | null,
  sceneAudioSlug: string | null,
  customPrompt: string,
  sourceAspect: SourceAspect,
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
      reference_video_urls: sceneClipSlug ? [`@${sceneClipSlug}`] : [],
      reference_audio_urls: sceneAudioSlug ? [`@${sceneAudioSlug}`] : [],
      resolution: '720p',
      aspect_ratio: seedanceAspectRatioForDimensions(sourceAspect.width, sourceAspect.height),
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
  sceneClipSlug: string,
  sceneAudioSlug: string,
  customPrompt: string,
  sourceAspect: SourceAspect,
): Record<string, unknown> {
  const swapped = readySwapAssetIds(scene, mediaItems);
  const imageSlugs = swapped
    ? swapped.map((id) => `@${id}`)
    : characters.map((c) => `@${c.asset_id}`);
  const trimmed = customPrompt.trim();
  return {
    prompt: trimmed.length > 0 ? trimmed : rewriteVisualWithImageTokens(scene.visual, characters),
    image_slugs: imageSlugs,
    video_slugs: [`@${sceneClipSlug}`],
    audio_slugs: [`@${sceneAudioSlug}`],
    // Server splices this audio over the seedance output before the asset
    // reaches 'ready'. Survives page reloads — the prior client-side
    // pendingAudioReplace effect did not.
    replace_audio_with: `@${sceneAudioSlug}`,
    resolution: '720p',
    aspect_ratio: seedanceAspectRatioForDimensions(sourceAspect.width, sourceAspect.height),
    duration: String(Math.min(15, Math.max(4, Math.round(scene.end - scene.start)))),
    generate_audio: false,
  };
}

// Per-frame self-contained block: provider/model dropdowns + prompt/JSON tabs
// + source→slot row. Owns its own (provider, model, prompt) state. Idle slot
// click and Regen both dispatch the selected (provider, model) for THAT frame
// only; for frame 2 the existing scene.swap.image1 (if any) is threaded as
// prior_swap_asset_id so identity carries over from the prior frame.
function FrameBlock({ ordinal, frameIndex, scene, sceneIndex, characters, mediaItems, sourceAspect, projectSlug, sourceSrc, tile, inFlightCodes, replacing, runSwap, onReplace, onErrorRetry }: {
  ordinal: 1 | 2;
  frameIndex: 1 | 2;
  scene: PlanScene;
  sceneIndex: number;
  characters: PlanSidecar['characters'];
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  projectSlug: string;
  sourceSrc: string;
  tile: FrameTileState;
  inFlightCodes: string[];
  replacing: boolean;
  runSwap: (
    frameIndex: 1 | 2,
    provider: SwapProvider,
    model: SwapModel,
    opts?: { priorSwapAssetId?: string; safeMode?: boolean; customPrompt?: string },
  ) => Promise<{ newAssetId: string } | null>;
  onReplace: (source: ReplaceSource) => void;
  onErrorRetry: () => void;
}) {
  const [selectedProvider, setSelectedProvider] = useState<SwapProvider>('kie');
  const [selectedModel, setSelectedModel] = useState<SwapModel>('nano-banana-pro');
  // One prompt per (provider, model) variant — switching the dropdown swaps
  // which prompt the editor / JSON view reads from. Frame 2 seeds with the
  // continuity prompt template since its inputs are [source last frame,
  // first frame swap] (no char refs).
  const [variantPrompts, setVariantPrompts] = useState<Record<string, string>>(
    () => makeEmptyModelPrompts(frameIndex),
  );

  const handleProviderChange = useCallback((next: SwapProvider) => {
    setSelectedProvider(next);
    // Snap model to one supported by the new provider — fal lacks gpt-image-2.
    setSelectedModel((prev) => (
      MODELS_BY_PROVIDER[next].includes(prev) ? prev : MODELS_BY_PROVIDER[next][0]
    ));
  }, []);

  const currentKey = variantKey(selectedProvider, selectedModel);
  const currentPrompt = variantPrompts[currentKey] ?? DEFAULT_PROMPT_BY_SWAP_MODEL[selectedModel];

  const setCurrentPrompt = useCallback((next: string) => {
    setVariantPrompts((prev) => ({ ...prev, [currentKey]: next }));
  }, [currentKey]);

  const payload = useMemo(
    () => buildSwapPayload(
      selectedProvider,
      selectedModel,
      characters,
      sceneIndex,
      frameIndex,
      currentPrompt,
      sourceAspect,
      frameIndex === 2 ? (scene.swap?.image1 ?? undefined) : undefined,
    ),
    [selectedProvider, selectedModel, characters, sceneIndex, frameIndex, currentPrompt, sourceAspect, scene.swap?.image1],
  );

  const dispatchGen = useCallback(() => {
    const priorSwapAssetId = frameIndex === 2 ? (scene.swap?.image1 ?? undefined) : undefined;
    void runSwap(frameIndex, selectedProvider, selectedModel, {
      customPrompt: currentPrompt,
      ...(priorSwapAssetId ? { priorSwapAssetId } : {}),
    });
  }, [runSwap, frameIndex, selectedProvider, selectedModel, currentPrompt, scene.swap?.image1]);

  const titleText = ordinal === 1 ? 'Generate first frame' : 'Generate last frame';
  const label = ordinal === 1
    ? `image1 · first ${formatTimecode(scene.start)}`
    : `image2 · last ${formatTimecode(scene.end)}`;

  return (
    <div className="px-3 py-3 border-b border-zinc-800/40 bg-black/20 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[11px] font-mono">
        <span className="inline-flex w-5 h-5 items-center justify-center rounded-full border border-emerald-500/40 text-emerald-300/80 text-[10px] font-bold">
          {ordinal}
        </span>
        <span className="text-emerald-300/70 uppercase tracking-wider">{titleText}</span>
      </div>
      <FrameImagePanel
        provider={selectedProvider}
        onProviderChange={handleProviderChange}
        model={selectedModel}
        onModelChange={setSelectedModel}
        prompt={currentPrompt}
        onPromptChange={setCurrentPrompt}
        payload={payload}
        mediaItems={mediaItems}
        projectSlug={projectSlug}
      />
      <SourceSlotRow
        sourceSrc={sourceSrc}
        sourceAspect={sourceAspect}
        state={tile}
        inFlightCodes={inFlightCodes}
        currentModelCode={modelCodeFromSwapAssetId(scene.swap?.[`image${frameIndex}` as 'image1' | 'image2'])}
        label={label}
        replacing={replacing}
        onReplace={onReplace}
        onIdleClick={dispatchGen}
        onErrorRetry={onErrorRetry}
        onRegen={dispatchGen}
      />
    </div>
  );
}

function SceneBlock({ scene, index, sceneCount, characters, sceneClipSlug, sceneAudioSlug, sceneSourceReady, mediaItems, sourceAspect, projectSlug, callTool, dispatch, onSidecarUpdate }: {
  scene: PlanScene;
  index: number;
  sceneCount: number;
  characters: PlanSidecar['characters'];
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  projectSlug: string;
  // Slugs in `<assetId>/<filename>` form, e.g. "plan/s1.mp4" — resolve via
  // the seedance/kie video+audio resolvers' slashed branch.
  sceneClipSlug: string | null;
  sceneAudioSlug: string | null;
  // True once PlanScenes' bootstrap has confirmed the per-scene clip+audio
  // files actually exist on disk. Gates RUN VIDEO; otherwise seedance would
  // get a half-written reference.
  sceneSourceReady: boolean;
  callTool: UseMcpResult['callTool'];
  dispatch: (input: string) => Promise<boolean>;
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}) {
  void dispatch;
  const [submittingVideo, setSubmittingVideo] = useState(false);
  // In-flight tags: `${variantKey}|${frameIndex}` (variantKey = bare model for
  // kie, `fal:{model}` for fal). A single (provider, model, frame) tuple can
  // be mid-flight while others run in parallel.
  const [swapsInFlight, setSwapsInFlight] = useState<Set<string>>(new Set());
  const [replacing, setReplacing] = useState<Set<1 | 2>>(new Set());
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
  // In-flight flag for the video slot's drag-drop replacement.
  const [replacingVideo, setReplacingVideo] = useState(false);
  // Pending img- asset waiting on extract_last_frame to finish so we can
  // forward it as scene N+1's accepted first frame. Cleared once the asset
  // reaches 'ready' and we dispatch replace_plan_scene_frame_swap.
  const [pendingLastFrameProp, setPendingLastFrameProp] = useState<{ imgAssetId: string; targetSceneIndex: number } | null>(null);

  const tile1 = deriveTileState(scene, 1, mediaItems);
  const tile2 = deriveTileState(scene, 2, mediaItems);
  const isGenerating = (s: FrameTileState) => s.kind === 'generating';
  const anySwapInFlight = swapsInFlight.size > 0 || isGenerating(tile1) || isGenerating(tile2);
  const inFlightCodes1 = useMemo(
    () => Array.from(swapsInFlight)
      .filter((t) => t.endsWith('|1'))
      .map((t) => {
        const key = t.slice(0, -2);
        const parsed = parseVariantKey(key);
        if (!parsed) return key;
        const short = SHORT_LABEL_BY_MODEL[parsed.model];
        return parsed.provider === 'fal' ? `${short}-fal` : short;
      }),
    [swapsInFlight],
  );
  const inFlightCodes2 = useMemo(
    () => Array.from(swapsInFlight)
      .filter((t) => t.endsWith('|2'))
      .map((t) => {
        const key = t.slice(0, -2);
        const parsed = parseVariantKey(key);
        if (!parsed) return key;
        const short = SHORT_LABEL_BY_MODEL[parsed.model];
        return parsed.provider === 'fal' ? `${short}-fal` : short;
      }),
    [swapsInFlight],
  );
  const swapsReady = tile1.kind === 'ready' && tile2.kind === 'ready';

  const runSwap = useCallback(async (
    frameIndex: 1 | 2,
    provider: SwapProvider,
    model: SwapModel,
    opts?: { priorSwapAssetId?: string; safeMode?: boolean; customPrompt?: string },
  ): Promise<{ newAssetId: string } | null> => {
    const key = variantKey(provider, model);
    const tag = `${key}|${frameIndex}`;
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
        provider,
        model,
        ...(opts?.priorSwapAssetId ? { prior_swap_asset_id: opts.priorSwapAssetId } : {}),
        ...(opts?.safeMode ? { safe_mode: true } : {}),
        ...(opts?.customPrompt && opts.customPrompt.trim().length > 0 ? { custom_prompt: opts.customPrompt.trim() } : {}),
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Swap failed';
        const code = provider === 'fal' ? `${SHORT_LABEL_BY_MODEL[model]}-fal` : SHORT_LABEL_BY_MODEL[model];
        toast({ title: `Scene ${index + 1} ${code} image${frameIndex} swap failed`, description: msg, duration: 5000 });
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
    const parsed = parseVariantKey(matched[0]);
    if (!parsed) return;
    const priorSwapAssetId = frameIndex === 2 ? (scene.swap?.image1 ?? undefined) : undefined;
    void runSwap(frameIndex, parsed.provider, parsed.model, {
      safeMode: true,
      ...(priorSwapAssetId ? { priorSwapAssetId } : {}),
    });
  }, [scene, runSwap]);

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
        const filename = `s${index + 1}-image${frameIndex}-user-${Date.now()}${ext}`;
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

  const videoGate = useMemo(() => videoReadyForGen(scene, tile1, tile2), [scene, tile1, tile2]);

  const handleVideo = useCallback(async () => {
    if (submittingVideo) return;
    if (!videoGate.ok) return;
    // The bootstrap in PlanScenes runs even_split + extract_audio per scene;
    // by the time the user clicks RUN VIDEO both ids should be reconciled.
    // If not, the user clicked too early — toast and let them retry.
    if (!sceneClipSlug || !sceneAudioSlug) {
      toast({
        title: `Scene ${index + 1} not ready`,
        description: 'Source clip + audio still extracting — try again in a moment.',
        duration: 4000,
      });
      return;
    }
    setSubmittingVideo(true);
    try {
      const toolName = TOOL_BY_VIDEO_MODEL[selectedVideoModel];
      const toolArgs = buildSeedanceToolArgs(scene, characters, mediaItems, sceneClipSlug, sceneAudioSlug, videoModelPrompts[selectedVideoModel], sourceAspect);
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
        // a toast-only notification.
      }
      if (newVidAssetId) {
        // Persist into scenes[N].swap.video so the slot survives reloads and
        // re-generations supersede the prior pick. The audio splice is now
        // server-driven (replace_audio_with arg above), so no client-side
        // post-completion coordination is needed.
        const persistResult = await callTool('replace_plan_scene_video_swap', {
          project_slug: projectSlug,
          scene_index: index,
          asset_id: newVidAssetId,
        });
        if (!persistResult.isError) {
          try {
            const text = (persistResult.content as Array<{ type: string; text: string }>)[0].text;
            const parsed = JSON.parse(text) as { sidecar?: PlanSidecar };
            if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
          } catch {
            // Sidecar refreshes on next read_plan.
          }
        }
      }
      const note = swapsReady ? 'Seedance 2 (kie) · 720p · swapped frames' : 'Seedance 2 (kie) · 720p · char refs';
      toast({ title: `Scene ${index + 1} enqueued`, description: note, duration: 2500 });
    } finally {
      setSubmittingVideo(false);
    }
  }, [submittingVideo, videoGate.ok, scene, characters, mediaItems, callTool, projectSlug, index, swapsReady, sceneClipSlug, sceneAudioSlug, selectedVideoModel, videoModelPrompts, sourceAspect, onSidecarUpdate]);

  // Slot-presence is acceptance: when a scene's video reaches 'ready', auto-fire
  // extract_last_frame and seed the next scene's first frame. One-shot per
  // (sceneIndex, videoAssetId) tuple — re-generations swap in a new asset id
  // and re-trigger; mediaItems churn for an unchanged id is ignored.
  const propagatedVideoIdRef = useRef<string | null>(null);
  useEffect(() => {
    const vidId = scene.swap?.video;
    if (!vidId) return;
    if (index + 1 >= sceneCount) return;
    if (propagatedVideoIdRef.current === vidId) return;
    const item = mediaItems.find((m) => m.id === vidId);
    if (!item || item.status !== 'ready') return;
    propagatedVideoIdRef.current = vidId;
    void (async () => {
      const extractResult = await callTool('extract_last_frame', {
        project_slug: projectSlug,
        asset_id: vidId,
      });
      if (extractResult.isError) {
        const msg = (extractResult.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'extract_last_frame failed';
        toast({ title: `Scene ${index + 1} last-frame extract failed`, description: msg, duration: 5000 });
        return;
      }
      try {
        const text = (extractResult.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { image_asset_id?: string };
        if (typeof parsed.image_asset_id === 'string') {
          setPendingLastFrameProp({ imgAssetId: parsed.image_asset_id, targetSceneIndex: index + 1 });
        }
      } catch {
        // Couldn't parse — skip propagation, regen will retry.
      }
    })();
  }, [scene.swap?.video, mediaItems, sceneCount, index, callTool, projectSlug]);

  const runVideoReplace = useCallback(async (vidAssetId: string) => {
    setReplacingVideo(true);
    try {
      const result = await callTool('replace_plan_scene_video_swap', {
        project_slug: projectSlug,
        scene_index: index,
        asset_id: vidAssetId,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Replace failed';
        toast({ title: `Scene ${index + 1} video replace failed`, description: msg, duration: 5000 });
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
      setReplacingVideo(false);
    }
  }, [callTool, projectSlug, index, onSidecarUpdate]);

  // Once the extracted last-frame img- asset reaches 'ready', forward it as
  // scene N+1's accepted first frame. One-shot per accept event.
  useEffect(() => {
    if (!pendingLastFrameProp) return;
    const item = mediaItems.find((m) => m.id === pendingLastFrameProp.imgAssetId);
    if (!item) return;
    if (item.status === 'error') {
      toast({ title: `Scene ${index + 1} last-frame extract errored`, description: item.failedMessage ?? 'extract failed', duration: 5000 });
      setPendingLastFrameProp(null);
      return;
    }
    if (item.status !== 'ready') return;
    const { imgAssetId, targetSceneIndex } = pendingLastFrameProp;
    setPendingLastFrameProp(null);
    void (async () => {
      const result = await callTool('replace_plan_scene_frame_swap', {
        project_slug: projectSlug,
        scene_index: targetSceneIndex,
        frame_index: 1,
        asset_id: imgAssetId,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'replace_plan_scene_frame_swap failed';
        toast({ title: `Scene ${targetSceneIndex + 1} first-frame seed failed`, description: msg, duration: 5000 });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { sidecar?: PlanSidecar };
        if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
      } catch {
        // Sidecar refreshes on next read_plan.
      }
      toast({
        title: `Scene ${targetSceneIndex + 1} first frame seeded`,
        description: `from ${imgAssetId}`,
        duration: 2500,
      });
    })();
  }, [pendingLastFrameProp, mediaItems, callTool, projectSlug, index, onSidecarUpdate]);

  const videoPayload = useMemo(
    () => buildKieVideoPayload(
      selectedVideoModel,
      scene,
      characters,
      mediaItems,
      sceneClipSlug,
      sceneAudioSlug,
      videoModelPrompts[selectedVideoModel],
      sourceAspect,
    ),
    [selectedVideoModel, videoModelPrompts, scene, characters, mediaItems, sceneClipSlug, sceneAudioSlug, sourceAspect],
  );

  // Both swap slots are filled with ready images — slot-presence is acceptance.
  // No-swap mode (char refs only) leaves bothReady false; videoGate.ok handles
  // that path so the video step still unlocks when the user skipped swaps.
  const bothReady = tile1.kind === 'ready' && tile2.kind === 'ready';
  const videoTileState = useMemo(
    () => deriveVideoTileState(scene, mediaItems, projectSlug),
    [scene, mediaItems, projectSlug],
  );

  const duration = (scene.end - scene.start).toFixed(2);

  // Cache-bust the source-frame thumbnails on scene-boundary changes — when
  // /plan-vis re-runs and produces different chunks, timestamps shift and the
  // same filename now points at a different frame.
  const v = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;
  const sourceUrl = (i: 1 | 2) =>
    `/files/${projectSlug}/plan/s${index + 1}-image${i}-source.jpg?v=${v}`;

  return (
    <section className="border border-zinc-800/60 rounded bg-zinc-950/40 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 bg-black/40">
        <div className="flex items-center gap-3 text-xs font-mono">
          <span className="text-emerald-300/50">Scene {index + 1}</span>
          <span className="text-emerald-300/90 font-bold">
            {formatTimecode(scene.start)} – {formatTimecode(scene.end)}
          </span>
          <span className="text-emerald-300/40">({duration}s)</span>
        </div>
      </header>
      <FrameBlock
        ordinal={1}
        frameIndex={1}
        scene={scene}
        sceneIndex={index}
        characters={characters}
        mediaItems={mediaItems}
        sourceAspect={sourceAspect}
        projectSlug={projectSlug}
        sourceSrc={sourceUrl(1)}
        tile={tile1}
        inFlightCodes={inFlightCodes1}
        replacing={replacing.has(1)}
        runSwap={runSwap}
        onReplace={(source) => { void runReplace(1, source); }}
        onErrorRetry={() => retryFailedSwap(1)}
      />
      <FrameBlock
        ordinal={2}
        frameIndex={2}
        scene={scene}
        sceneIndex={index}
        characters={characters}
        mediaItems={mediaItems}
        sourceAspect={sourceAspect}
        projectSlug={projectSlug}
        sourceSrc={sourceUrl(2)}
        tile={tile2}
        inFlightCodes={inFlightCodes2}
        replacing={replacing.has(2)}
        runSwap={runSwap}
        onReplace={(source) => { void runReplace(2, source); }}
        onErrorRetry={() => retryFailedSwap(2)}
      />
      <VideoStepBlock
        bothReady={bothReady}
        selectedModel={selectedVideoModel}
        onSelectModel={setSelectedVideoModel}
        prompt={videoModelPrompts[selectedVideoModel]}
        onPromptChange={setSelectedVideoPrompt}
        payload={videoPayload}
        mediaItems={mediaItems}
        sourceAspect={sourceAspect}
        projectSlug={projectSlug}
        disabled={!bothReady || !videoGate.ok || anySwapInFlight || !sceneSourceReady || submittingVideo}
        disabledReason={
          !bothReady
            ? 'Both swap frames must finish generating'
            : !videoGate.ok
              ? videoGate.reason
              : anySwapInFlight
                ? 'Swap still running'
                : !sceneSourceReady
                  ? 'Source clip + audio still extracting…'
                  : submittingVideo
                    ? 'Video gen submitting…'
                    : undefined
        }
        videoTileState={videoTileState}
        videoAssetId={scene.swap?.video ?? null}
        replacing={replacingVideo}
        onIdleClick={() => { void handleVideo(); }}
        onReplace={(vidAssetId) => { void runVideoReplace(vidAssetId); }}
        onErrorRetry={() => { void handleVideo(); }}
        onRegen={() => { void handleVideo(); }}
      />
    </section>
  );
}

// Step-3 wrapper around the existing VideoPanel. Always visible — when both
// swap frames haven't landed yet, the contents are dimmed and Run Video stays
// disabled with an explanatory tooltip.
function VideoStepBlock({ bothReady, ...rest }: {
  bothReady: boolean;
  selectedModel: VideoModel;
  onSelectModel: (model: VideoModel) => void;
  prompt: string;
  onPromptChange: (next: string) => void;
  payload: unknown;
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  projectSlug: string;
  disabled: boolean;
  disabledReason?: string;
  videoTileState: VideoTileState;
  videoAssetId: string | null;
  replacing: boolean;
  onIdleClick: () => void;
  onReplace: (videoAssetId: string) => void;
  onErrorRetry?: () => void;
  onRegen: () => void;
}) {
  return (
    <div className="px-3 py-3 border-t border-zinc-800/40 bg-black/20 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[11px] font-mono">
        <span
          className={cn(
            'inline-flex w-5 h-5 items-center justify-center rounded-full text-[10px] font-bold',
            bothReady
              ? 'border border-emerald-500/40 text-emerald-300/80'
              : 'border border-emerald-500/15 text-emerald-300/30',
          )}
        >
          3
        </span>
        <span
          className={cn(
            'uppercase tracking-wider',
            bothReady ? 'text-emerald-300/70' : 'text-emerald-300/30',
          )}
        >
          Generate scene video
        </span>
        {!bothReady && (
          <span className="text-emerald-300/40 text-[10px] italic">
            (waiting for both swap frames)
          </span>
        )}
      </div>
      <div className={cn(!bothReady && 'opacity-50 pointer-events-none')}>
        <VideoPanel {...rest} />
      </div>
    </div>
  );
}

function VideoPanel({ selectedModel, onSelectModel, models = ALL_VIDEO_MODELS, prompt, onPromptChange, payload, mediaItems, sourceAspect, projectSlug, disabled, disabledReason, videoTileState, videoAssetId, replacing, onIdleClick, onReplace, onErrorRetry, onRegen }: {
  selectedModel: VideoModel;
  onSelectModel: (model: VideoModel) => void;
  models?: VideoModel[];
  prompt: string;
  onPromptChange: (next: string) => void;
  payload: unknown;
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  projectSlug: string;
  disabled: boolean;
  disabledReason?: string;
  videoTileState: VideoTileState;
  videoAssetId: string | null;
  replacing: boolean;
  onIdleClick: () => void;
  onReplace: (videoAssetId: string) => void;
  onErrorRetry?: () => void;
  onRegen: () => void;
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
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-x-2">
        {models.map((m) => (
          <TabButton
            key={m}
            active={selectedModel === m}
            onClick={() => onSelectModel(m)}
            icon={null}
          >
            {LABEL_BY_VIDEO_MODEL[m]}
          </TabButton>
        ))}
      </div>
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
              'text-emerald-300/70 hover:text-emerald-300',
              'bg-emerald-500/5 hover:bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40',
              'transition-colors duration-150',
            )}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {view === 'prompt' ? (
        <PromptEditor
          value={prompt}
          onChange={onPromptChange}
          mediaItems={mediaItems}
          projectSlug={projectSlug}
        />
      ) : (
        <PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />
      )}
      <VideoSwapSlot
        state={videoTileState}
        sourceAspect={sourceAspect}
        videoAssetId={videoAssetId}
        replacing={replacing}
        disabled={disabled}
        disabledReason={disabledReason}
        onReplace={onReplace}
        onIdleClick={onIdleClick}
        onErrorRetry={onErrorRetry}
        onRegen={onRegen}
      />
    </div>
  );
}

// Slug pattern: `@<prefix><id>` where prefix is one of the known asset id
// prefixes plus `plan/` for the synthetic source-frame slug. Restricted to
// these so prompt text like `@Image1` (used by rewriteVisualWithImageTokens)
// doesn't get mis-matched as an asset reference.
const SLUG_TOKEN_REGEX = /"(@(?:img-|vid-|aud-|char-|plan\/)[\w\-./]+)"/g;

interface SlugThumb {
  kind: 'image' | 'waveform';
  src: string | null;
  waveform: number[] | null;
}

function resolveSlugThumb(
  slug: string,
  mediaItems: MediaItem[],
  projectSlug: string,
): SlugThumb | null {
  const id = slug.startsWith('@') ? slug.slice(1) : slug;
  const planMatch = id.match(/^plan\/((?:scene-\d+|s\d+)-image\d+-source\.jpg)$/);
  if (planMatch) {
    return { kind: 'image', src: `/files/${projectSlug}/plan/${planMatch[1]}`, waveform: null };
  }
  const item = mediaItems.find((m) => m.id === id);
  if (!item) return null;
  // Audio assets show a mini-waveform strip in place of an image thumb. Prefer
  // waveform over thumbnailSrc so audio with both falls through to the audible
  // representation.
  if (item.type === 'audio' && item.waveform && item.waveform.length > 0) {
    return { kind: 'waveform', src: null, waveform: item.waveform };
  }
  return item.thumbnailSrc
    ? { kind: 'image', src: item.thumbnailSrc, waveform: null }
    : null;
}

// 16px-tall mini waveform — 24 bars max, downsampled if the source has more
// samples. Matches the size of the inline image thumb so JSON-view tokens
// align on a single baseline regardless of asset type.
function InlineWaveformThumb({ peaks }: { peaks: number[] }) {
  const BARS = 24;
  const bars = peaks.length <= BARS
    ? peaks
    : Array.from({ length: BARS }, (_, i) => peaks[Math.floor((i * peaks.length) / BARS)]);
  const max = Math.max(...bars, 1);
  return (
    <span
      className="inline-flex items-end gap-[1px] align-middle h-4 w-8 rounded ring-1 ring-zinc-700/60 bg-black/40 px-[2px]"
      aria-hidden
    >
      {bars.map((v, i) => (
        <span
          key={i}
          className="flex-1 min-w-0 bg-cyan-500/70 rounded-[0.5px]"
          style={{ height: `${Math.max((v / max) * 100, 12)}%` }}
        />
      ))}
    </span>
  );
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
        {thumb?.kind === 'image' && thumb.src && (
          <img
            src={thumb.src}
            alt=""
            className="w-4 h-4 inline-block rounded object-cover ring-1 ring-zinc-700/60 align-middle"
          />
        )}
        {thumb?.kind === 'waveform' && thumb.waveform && (
          <InlineWaveformThumb peaks={thumb.waveform} />
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
    <pre
      className="p-2 rounded bg-black/60 border border-zinc-700 text-xs leading-relaxed text-emerald-300/85 font-mono whitespace-pre overflow-auto scrollbar-domain max-h-72"
      style={{ '--scrollbar-rgb': '52, 211, 153' } as React.CSSProperties}
    >
      {lines.map((line, i) => (
        <span key={i}>
          {renderJsonLine(line, mediaItems, projectSlug, i)}
          {i < lines.length - 1 && '\n'}
        </span>
      ))}
    </pre>
  );
}

// Token regex for the prompt-text view — matches @<prefix><id> bare (no
// surrounding quotes). Restricted to known asset prefixes plus `plan/` so
// in-prose mentions like `@Image1` don't get spuriously chipped.
const PROMPT_TOKEN_REGEX = /@(?:img-|vid-|aud-|char-|plan\/)[\w\-./]+/g;

// Tab/color-coded chip palette — one stable color per distinct token in the
// prompt, so re-mentions of the same asset always render in the same hue.
const CHIP_PALETTE: Array<{ ring: string; text: string; bg: string }> = [
  { ring: 'ring-emerald-400/50', text: 'text-emerald-200', bg: 'bg-emerald-500/15' },
  { ring: 'ring-sky-400/50', text: 'text-sky-200', bg: 'bg-sky-500/15' },
  { ring: 'ring-fuchsia-400/50', text: 'text-fuchsia-200', bg: 'bg-fuchsia-500/15' },
  { ring: 'ring-amber-400/50', text: 'text-amber-200', bg: 'bg-amber-500/15' },
  { ring: 'ring-violet-400/50', text: 'text-violet-200', bg: 'bg-violet-500/15' },
  { ring: 'ring-rose-400/50', text: 'text-rose-200', bg: 'bg-rose-500/15' },
];

function paletteForIndex(i: number): typeof CHIP_PALETTE[number] {
  return CHIP_PALETTE[i % CHIP_PALETTE.length];
}

function renderPromptLine(
  line: string,
  mediaItems: MediaItem[],
  projectSlug: string,
  colorByToken: Map<string, number>,
  lineKey: number,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  PROMPT_TOKEN_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let tokenKey = 0;
  let match: RegExpExecArray | null;
  while ((match = PROMPT_TOKEN_REGEX.exec(line)) !== null) {
    if (match.index > lastIndex) parts.push(line.slice(lastIndex, match.index));
    const slug = match[0];
    const thumb = resolveSlugThumb(slug, mediaItems, projectSlug);
    const idx = colorByToken.get(slug) ?? 0;
    const palette = paletteForIndex(idx);
    parts.push(
      <span
        key={`${lineKey}-${tokenKey++}`}
        className={cn(
          'inline-flex items-center gap-1 align-middle px-1 py-px rounded ring-1',
          palette.bg, palette.text, palette.ring,
        )}
      >
        {thumb?.kind === 'image' && thumb.src && (
          <img
            src={thumb.src}
            alt=""
            className="w-3.5 h-3.5 inline-block rounded object-cover align-middle"
          />
        )}
        {thumb?.kind === 'waveform' && thumb.waveform && (
          <InlineWaveformThumb peaks={thumb.waveform} />
        )}
        <span>{slug}</span>
      </span>,
    );
    lastIndex = PROMPT_TOKEN_REGEX.lastIndex;
  }
  if (lastIndex < line.length) parts.push(line.slice(lastIndex));
  return parts;
}

// Two-mode prompt input: chip-view (colored tokens with inline thumbs) when
// not focused, plain textarea when focused. Click-to-edit, blur to view.
function PromptEditor({ value, onChange, mediaItems, projectSlug }: {
  value: string;
  onChange: (next: string) => void;
  mediaItems: MediaItem[];
  projectSlug: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editing]);
  const handleEdit = useCallback(() => {
    setEditorHeight(previewRef.current?.getBoundingClientRect().height ?? null);
    setEditing(true);
  }, []);
  // Stable color assignment: first distinct token gets palette[0], second
  // distinct token gets palette[1], and so on. Matches reads in renderPromptLine.
  const colorByToken = useMemo(() => {
    const map = new Map<string, number>();
    let next = 0;
    for (const m of value.matchAll(PROMPT_TOKEN_REGEX)) {
      if (!map.has(m[0])) {
        map.set(m[0], next++);
      }
    }
    return map;
  }, [value]);
  const lines = useMemo(() => value.split('\n'), [value]);
  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        rows={4}
        style={editorHeight == null ? undefined : { height: `${editorHeight}px` }}
        className={cn(
          'w-full p-2 rounded bg-black/60 border border-zinc-700 text-[11px] font-mono text-emerald-300/90 resize-y',
          'focus:outline-none focus:border-emerald-500/60',
          'placeholder:text-emerald-300/40',
        )}
      />
    );
  }
  return (
    <button
      ref={previewRef}
      type="button"
      onClick={handleEdit}
      title="Click to edit prompt"
      className={cn(
        'w-full text-left p-2 rounded bg-black/60 border border-zinc-700',
        'text-[11px] font-mono text-emerald-300/90 leading-relaxed',
        'whitespace-pre-wrap break-words',
        'hover:border-emerald-500/40 transition-colors cursor-text min-h-[5rem]',
      )}
    >
      {lines.map((line, i) => (
        <span key={i}>
          {renderPromptLine(line, mediaItems, projectSlug, colorByToken, i)}
          {i < lines.length - 1 && '\n'}
        </span>
      ))}
    </button>
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
          ? 'text-emerald-300 border-emerald-400'
          : 'text-emerald-300/40 border-transparent hover:text-emerald-300/70',
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

function PlanHeaderSlot({ label, kind, item, sourceAspect, onDrop }: {
  label: string;
  kind: PlanSlotKind;
  item: MediaItem | null;
  sourceAspect?: SourceAspect;
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
  const slotStyle = kind === 'source' && sourceAspect ? { aspectRatio: sourceAspect.css } : undefined;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/50">{label}</span>
      <div
        className={cn(
          'relative w-44 bg-zinc-900 border rounded overflow-hidden flex items-center justify-center transition-colors',
          kind !== 'source' && 'aspect-video',
          dragActive ? 'border-emerald-300 ring-2 ring-emerald-300/40' : 'border-zinc-700/60',
        )}
        style={slotStyle}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDrop={handleDrop}
      >
        {item && src ? (
          <img src={src} alt={item.slug} className="w-full h-full object-contain" loading="lazy" />
        ) : item ? (
          <FileText className="w-6 h-6 text-emerald-300/40" />
        ) : (
          <span className="text-[11px] font-mono text-emerald-300/50 px-2 text-center">drop {kind === 'source' ? 'video' : 'character'}</span>
        )}
        {dragActive && (
          <div className="absolute inset-0 flex items-center justify-center bg-emerald-500/30 pointer-events-none">
            <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-50 font-bold">drop to set</span>
          </div>
        )}
      </div>
      <div className="text-[10px] font-mono text-emerald-300/60 truncate w-44">{item?.slug ?? '—'}</div>
    </div>
  );
}

function PlanHeader({ sourceId, charAId, charBId, mediaItems, sourceAspect, duration, scenesCount, canGenerate, generating, onSourceDrop, onCharADrop, onCharBDrop, onGenerate, onBack }: {
  sourceId: string | null;
  charAId: string | null;
  charBId: string | null;
  mediaItems: MediaItem[];
  sourceAspect: SourceAspect;
  duration: number | null;
  scenesCount: number | null;
  canGenerate: boolean;
  generating: boolean;
  onSourceDrop: (id: string) => void;
  onCharADrop: (id: string) => void;
  onCharBDrop: (id: string) => void;
  onGenerate: () => void;
  onBack: () => void;
}) {
  const sourceItem = sourceId ? mediaItems.find((m) => m.id === sourceId) ?? null : null;
  const charAItem = charAId ? mediaItems.find((m) => m.id === charAId) ?? null : null;
  const charBItem = charBId ? mediaItems.find((m) => m.id === charBId) ?? null : null;
  return (
    <div className="mb-6 pb-4 border-b border-zinc-800/60">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <PlanBackButton onBack={onBack} />
          <h1 className="text-lg font-bold text-emerald-300 font-mono uppercase tracking-wider truncate">Plan: char swap</h1>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating || !canGenerate}
          title={canGenerate ? 'Generate plan from these slots' : 'Drop a video source and two distinct characters'}
          className={cn(
            'h-8 px-3 flex items-center gap-1.5 rounded',
            'text-xs font-mono font-bold uppercase tracking-wider',
            'text-emerald-300 hover:text-white',
            'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 hover:border-emerald-500/70',
            'transition-colors duration-150',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
          {generating ? 'Generating…' : 'Generate Plan'}
        </button>
      </div>
      <div className="flex flex-wrap gap-4 mb-4">
        <PlanHeaderSlot label="Video Source" kind="source" item={sourceItem} sourceAspect={sourceAspect} onDrop={onSourceDrop} />
        <PlanHeaderSlot label="Char A" kind="character" item={charAItem} onDrop={onCharADrop} />
        <PlanHeaderSlot label="Char B" kind="character" item={charBItem} onDrop={onCharBDrop} />
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs font-mono items-center">
        <dt className="text-emerald-300/60">Duration</dt>
        <dd className="text-emerald-300/90">{duration != null ? `${duration.toFixed(2)}s` : '—'}</dd>
        <dt className="text-emerald-300/60">Scenes</dt>
        <dd className="text-emerald-300/90">
          {scenesCount != null ? `~${scenesCount} (7–14s each, shot-aligned)` : '—'}
        </dd>
      </dl>
    </div>
  );
}

interface VisionAuditScene {
  start: number;
  end: number;
  frames: Array<{ name: string; t: number }>;
}

interface VisionAuditData {
  headline: 'pre-flight' | 'post-gen';
  sourceAssetId: string;
  scenes: VisionAuditScene[];
  totalFrames: number;
  wordCount: number | null;
  systemPrompt: string | null;
  userContext: string | null;
}

function VisionAuditView({ data, projectSlug }: {
  data: VisionAuditData;
  projectSlug: string;
}) {
  const heading = data.headline === 'pre-flight' ? 'Pre-flight preview' : 'Vision input (sent to model)';
  const wordsLine = data.wordCount != null
    ? `${data.wordCount} transcribed words`
    : 'no word-level transcript stored';
  return (
    <div className="mb-6 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs font-mono uppercase tracking-wider text-emerald-300/70">
          {heading}
        </div>
        <div className="text-xs font-mono text-emerald-300/40">
          {data.scenes.length} scenes · {data.totalFrames} frames · {wordsLine}
        </div>
      </div>
      <div className="space-y-3">
        {data.scenes.map((scene, i) => (
          <PlanPreviewSceneRow
            key={`${scene.start}-${scene.end}-${i}`}
            scene={scene}
            sceneIndex={i}
            sourceId={data.sourceAssetId}
            projectSlug={projectSlug}
          />
        ))}
      </div>
      {data.userContext && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-mono uppercase tracking-wider text-emerald-300/70 hover:text-emerald-300 transition-colors duration-150 select-none">
            User message <span className="text-emerald-300/40">(per-chunk context sent alongside frames)</span>
          </summary>
          <pre className="mt-2 p-3 rounded border border-zinc-800/60 bg-zinc-950/80 text-[11px] leading-relaxed font-mono text-emerald-200/80 whitespace-pre-wrap break-words overflow-auto max-h-[40vh]">
            {data.userContext}
          </pre>
        </details>
      )}
      {data.systemPrompt && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-mono uppercase tracking-wider text-emerald-300/70 hover:text-emerald-300 transition-colors duration-150 select-none">
            System prompt <span className="text-emerald-300/40">(sent to vision model)</span>
          </summary>
          <pre className="mt-2 p-3 rounded border border-zinc-800/60 bg-zinc-950/80 text-[11px] leading-relaxed font-mono text-emerald-200/80 whitespace-pre-wrap break-words overflow-auto max-h-[40vh]">
            {data.systemPrompt}
          </pre>
        </details>
      )}
    </div>
  );
}

interface PlanPreviewPayload {
  source_asset_id: string;
  scenes: VisionAuditScene[];
  total_frames: number;
  has_word_timings: boolean;
  word_count: number;
  system_prompt: string;
  user_context: string;
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PlanPreviewPayload }
  | { kind: 'error'; message: string };

function PlanPreviewBlock({ sourceId, charAId, charBId, projectSlug, callTool }: {
  sourceId: string;
  charAId: string;
  charBId: string;
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
}) {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Defer the loading-state flip into the async closure so the synchronous
      // effect body stays setState-free (react-hooks/set-state-in-effect).
      setState({ kind: 'loading' });
      const result = await callTool('plan_preview', {
        source_asset_id: sourceId,
        project_slug: projectSlug,
        character_asset_ids: [charAId, charBId],
      });
      if (cancelled) return;
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'preview failed';
        setState({ kind: 'error', message: msg });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed: PlanPreviewPayload = JSON.parse(text);
        setState({ kind: 'ready', data: parsed });
      } catch (err) {
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId, charAId, charBId, projectSlug, callTool]);

  if (state.kind === 'loading') {
    return (
      <div className="mb-6 flex items-center gap-2 text-xs font-mono text-emerald-300/60">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Computing scene boundaries and sampling frames…</span>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mb-6 rounded border border-amber-600/40 bg-amber-950/20 p-3 text-amber-200 text-xs font-mono">
        Preview unavailable: {state.message}
      </div>
    );
  }

  const { data } = state;
  return (
    <VisionAuditView
      data={{
        headline: 'pre-flight',
        sourceAssetId: data.source_asset_id,
        scenes: data.scenes,
        totalFrames: data.total_frames,
        wordCount: data.has_word_timings ? data.word_count : null,
        systemPrompt: data.system_prompt,
        userContext: data.user_context,
      }}
      projectSlug={projectSlug}
    />
  );
}

function PlanAuditFromSidecar({ sidecar, projectSlug }: {
  sidecar: PlanSidecar;
  projectSlug: string;
}) {
  const scenes = useMemo<VisionAuditScene[]>(
    () => sidecar.scenes.map((s) => ({
      start: s.start,
      end: s.end,
      frames: s.frames ?? [],
    })),
    [sidecar.scenes],
  );
  const totalFrames = scenes.reduce((acc, s) => acc + s.frames.length, 0);
  const hasAnyFrames = totalFrames > 0;
  const hasAnyAuditData = hasAnyFrames || Boolean(sidecar.user_context) || Boolean(sidecar.analysis_prompt);
  if (!hasAnyAuditData) return null;
  return (
    <VisionAuditView
      data={{
        headline: 'post-gen',
        sourceAssetId: sidecar.source_asset_id,
        scenes,
        totalFrames,
        wordCount: sidecar.word_count ?? null,
        systemPrompt: sidecar.analysis_prompt ?? null,
        userContext: sidecar.user_context ?? null,
      }}
      projectSlug={projectSlug}
    />
  );
}

function PlanPreviewSceneRow({ scene, sceneIndex, sourceId, projectSlug }: {
  scene: VisionAuditScene;
  sceneIndex: number;
  sourceId: string;
  projectSlug: string;
}) {
  const duration = (scene.end - scene.start).toFixed(2);
  return (
    <div className="rounded border border-zinc-800/60 bg-zinc-950/40 p-3">
      <div className="flex items-center justify-between mb-2 text-xs font-mono">
        <span className="text-emerald-300/90">
          Scene {sceneIndex + 1} — {scene.start.toFixed(2)}s – {scene.end.toFixed(2)}s ({duration}s)
        </span>
        <span className="text-emerald-300/40">{scene.frames.length} frame{scene.frames.length === 1 ? '' : 's'}</span>
      </div>
      {scene.frames.length === 0 ? (
        <div className="text-[11px] font-mono text-amber-300/60">No frames in window — vision model would receive no input for this scene.</div>
      ) : (
        <div
          className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-domain"
          style={{ '--scrollbar-rgb': '52, 211, 153' } as React.CSSProperties}
        >
          {scene.frames.map((frame) => (
            <div key={frame.name} className="flex-none">
              <img
                src={`/files/${projectSlug}/${sourceId}/original_frames/${frame.name}`}
                alt={`t=${frame.t.toFixed(2)}s`}
                className="h-20 w-auto rounded border border-zinc-800/60 object-cover"
                loading="lazy"
              />
              <div className="text-[9px] font-mono text-emerald-300/40 mt-0.5 text-center">
                {frame.t.toFixed(2)}s
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

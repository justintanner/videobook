import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, ChevronRight, Film, Loader2, MapPin, Play, Square, X, FileText, Code, Copy, Check, RefreshCw, Images, Mic, Volume2, LayoutTemplate, Plus, Sparkles, Pencil, Share2 } from 'lucide-react';
import { CloseButton } from '@/components/ui/CloseButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { FOCUS_RING_BUTTON } from '@/components/ui/interaction-states';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { useOptionalCommandRegistry } from '@/contexts/CommandRegistryContext';
import { useMountKey } from '@/contexts/MountKeyContext';
import { ViewerToolbar } from './viewer-shared';
import { uploadProjectFile } from '@/lib/upload';
import {
  sourceAspectFromDimensions,
  type SourceAspect,
} from '@/lib/plan-aspect';
import { autoPickCharSwap, autoPickClipShow, autoPickStoryboard } from './templates/auto-pick';
import { useSceneFilesBootstrap } from './plan/useSceneFilesBootstrap';
import {
  ALL_SWAP_PROVIDERS,
  ALL_VIDEO_MODELS,
  DEFAULT_PROMPT_BY_SWAP_MODEL,
  KIE_MODEL_NAME_BY_VIDEO,
  LABEL_BY_VIDEO_MODEL,
  MODELS_BY_PROVIDER,
  PLAN_ASSET_ID,
  SHORT_LABEL_BY_MODEL,
  STORYBOARD_VIDEO_MODELS,
  TOOL_BY_VIDEO_MODEL,
  buildGrokImagineToolArgs,
  buildKieVideoPayload,
  buildSeedanceToolArgs,
  buildSwapPayload,
  deriveTileState,
  deriveVideoTileState,
  formatTimecode,
  grokVideoReadyForGen,
  makeEmptyModelPrompts,
  modelCodeFromSwapAssetId,
  parseVariantKey,
  rewriteVisualWithImageTokens,
  variantKey,
  videoReadyForGen,
  type FrameTileState,
  type PlanScene,
  type PlanSidecar,
  type SwapModel,
  type SwapProvider,
  type VideoModel,
  type VideoTileState,
} from './plan/charSwapModel';

export type PlanFormula = 'char_swap' | 'storyboard_video' | 'clip_show';

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

interface ClipShowCharacter {
  asset_id: string;
  name: string;
  description: string;
  elevenlabs_voice_id: string;
}

// One on-screen graphic in a joke's visual run (mirrors server ClipShowOsg).
interface ClipShowOsg {
  source: 'upload' | 'generated';
  image_asset_id: string | null;
  image_prompt: string | null;
  treatment: string;
  beat_text: string;
  caption: string | null;
  duration_ms: number;
}

// One joke = host voiceover + an ordered run of OSGs.
interface ClipShowSegment {
  source_image_asset_ids: string[];
  source_summary: string;
  joke: string;
  joke_notes?: string;
  joke_type?: string;
  osgs: ClipShowOsg[];
  audio_asset_id?: string | null;
}

// Visual treatments offered by the per-OSG dropdown. Mirrors the server's
// CLIP_SHOW_TREATMENTS (id + label only).
const CLIP_SHOW_TREATMENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'photo', label: 'Photo' },
  { id: 'cityscape', label: 'Cityscape' },
  { id: 'map', label: 'Map' },
  { id: 'headline', label: 'Headline' },
  { id: 'fake_poster', label: 'Fake poster' },
  { id: 'title_card', label: 'Title card' },
  { id: 'caption', label: 'Caption' },
  { id: 'portrait', label: 'Portrait' },
];

// Comedic styles offered by the per-joke type dropdown. Mirrors the server's
// CLIP_SHOW_JOKE_TYPES (id + label only — the prompt hint lives server-side).
const CLIP_SHOW_JOKE_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'observational', label: 'Observational' },
  { id: 'one_liner', label: 'One-liner' },
  { id: 'pun', label: 'Pun / wordplay' },
  { id: 'deadpan', label: 'Deadpan' },
  { id: 'absurdist', label: 'Absurdist' },
  { id: 'roast', label: 'Roast' },
  { id: 'self_deprecating', label: 'Self-deprecating' },
  { id: 'hyperbole', label: 'Hyperbole' },
];
const DEFAULT_JOKE_TYPE = 'auto';

interface ClipShowPlanSidecar {
  formula: 'clip_show';
  character: ClipShowCharacter;
  show_brief: string;
  tone: string;
  model: 'gpt-5.5';
  image_model: 'generate_nano_banana_pro_fal';
  audio_model: 'elevenlabs';
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

interface PlanViewerProps {
  item: MediaItem | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  resetKey?: number;
  onClose: () => void;
  // Open the /templates marketplace (a separate center stage) to create or
  // replace this project's plan. Plan generation now lives there, not here.
  onBackToTemplates: () => void;
}

export function PlanViewer({ item, mediaItems, projectSlug, callTool, resetKey, onClose, onBackToTemplates }: PlanViewerProps) {
  useMountKey('viewer');
  return (
    <PlanBody
      item={item}
      mediaItems={mediaItems}
      projectSlug={projectSlug}
      callTool={callTool}
      resetKey={resetKey}
      onClose={onClose}
      onBackToTemplates={onBackToTemplates}
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
              <CloseButton tabIndex={-1} onClick={onClose} tone="emerald" />
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

function PlanBody({ item, mediaItems, projectSlug, callTool, resetKey, onClose, onBackToTemplates }: {
  item: MediaItem | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  resetKey?: number;
  onClose: () => void;
  onBackToTemplates: () => void;
}) {
  const { dispatch } = useCommandDispatch();
  const [sidecar, setSidecar] = useState<AnyPlanSidecar | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(true);
  const cancelledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // /plan is now a pure work area: the formula comes from the existing plan
  // sidecar (generation moved to the /templates marketplace). Null → no plan.
  const formula = planFormula(sidecar);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [formula, resetKey]);

  // Load read_plan on mount / when the plan asset changes. A read failure here
  // means "no plan yet" — sidecar stays null and the empty state takes over.
  useEffect(() => {
    if (!projectSlug) return;
    cancelledRef.current = false;
    setLoadingPlan(true);
    void (async () => {
      const result = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelledRef.current) return;
      if (result.isError) {
        setSidecar(null);
        setLoadingPlan(false);
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        setSidecar(JSON.parse(text) as AnyPlanSidecar);
      } catch {
        setSidecar(null);
      } finally {
        if (!cancelledRef.current) setLoadingPlan(false);
      }
    })();
    return () => { cancelledRef.current = true; };
  }, [callTool, projectSlug, item?.id, item?.prompt]);

  const charSidecar = planFormula(sidecar) === 'char_swap' ? sidecar as PlanSidecar : null;
  const storyboardVideoSidecar = isStoryboardVideoPlan(sidecar) ? sidecar : null;
  const clipShowSidecar = isClipShowPlan(sidecar) ? sidecar : null;

  // The graph is char_swap's sole UI: once a char_swap plan loads, auto-open the
  // full-screen graph (the scene list below stays mounted only to run the shared
  // clip/audio bootstrap — closing the graph deselects the plan, so it's never
  // shown). Fire once per mount so closing the graph doesn't immediately reopen it.
  const registry = useOptionalCommandRegistry();
  const openGraph = registry?.uiActions.open_plan_flow;
  const autoOpenedGraphRef = useRef(false);
  useEffect(() => {
    if (formula === 'char_swap' && charSidecar && openGraph && !autoOpenedGraphRef.current) {
      autoOpenedGraphRef.current = true;
      openGraph();
    }
  }, [formula, charSidecar, openGraph]);

  const charSourceItem = useMemo(
    () => (charSidecar?.source_asset_id ? mediaItems.find((m) => m.id === charSidecar.source_asset_id) ?? null : null),
    [charSidecar?.source_asset_id, mediaItems],
  );
  const charSourceAspect = useMemo(
    () => sourceAspectFromDimensions(charSourceItem?.width, charSourceItem?.height),
    [charSourceItem?.width, charSourceItem?.height],
  );

  const slug = sidecar ? (item?.slug ?? 'plan') : 'plan (not yet generated)';
  const title = formula == null
    ? 'PLAN'
    : formula === 'clip_show'
    ? 'PLAN: CLIP SHOW'
    : formula === 'storyboard_video' ? 'PLAN: STORYBOARD' : 'PLAN: CHAR SWAP';
  // While the initial read_plan is in flight, hold off rendering so the empty
  // state doesn't flash before an existing plan loads.
  const showLoading = loadingPlan && formula == null;

  return (
    <PlanShell title={title} slug={slug} onClose={onClose}>
      <div
        ref={scrollRef}
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-domain"
        style={{ '--scrollbar-rgb': '52, 211, 153' } as React.CSSProperties}
      >
        <div className="w-full min-w-0 px-4 sm:px-6 py-5">
          {showLoading ? (
            <div className="min-h-[40vh] flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-emerald-400/60" />
            </div>
          ) : formula == null ? (
            <PlanEmptyState onBackToTemplates={onBackToTemplates} />
          ) : (
            <>
              <div className="mb-4 flex items-center gap-2">
                <PlanBackButton onBack={onBackToTemplates} />
                {formula === 'char_swap' && charSidecar ? <PlanGraphViewButton /> : null}
              </div>
              {formula === 'char_swap' && charSidecar ? (
                <>
                  <PlanAuditFromSidecar sidecar={charSidecar} projectSlug={projectSlug} />
                  <PlanScenes
                    data={charSidecar}
                    mediaItems={mediaItems}
                    sourceAspect={charSourceAspect}
                    projectSlug={projectSlug}
                    callTool={callTool}
                    dispatch={dispatch}
                    onSidecarUpdate={(next) => setSidecar(next)}
                  />
                </>
              ) : formula === 'storyboard_video' ? (
                <StoryboardVideoPlanFormula
                  sidecar={storyboardVideoSidecar}
                  mediaItems={mediaItems}
                  projectSlug={projectSlug}
                  callTool={callTool}
                  onSidecarUpdate={(next) => setSidecar(next)}
                />
              ) : (
                <ClipShowWork
                  sidecar={clipShowSidecar}
                  mediaItems={mediaItems}
                  projectSlug={projectSlug}
                  callTool={callTool}
                  onSidecarUpdate={(next) => setSidecar(next)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </PlanShell>
  );
}

function PlanEmptyState({ onBackToTemplates }: { onBackToTemplates: () => void }) {
  return (
    <div className="min-h-[40vh] flex flex-col items-center justify-center text-center gap-4">
      <EmptyState size="md">No template selected for this plan.</EmptyState>
      <button
        type="button"
        onClick={onBackToTemplates}
        className={cn(
          'h-8 px-3 flex items-center gap-1.5 rounded',
          'text-xs font-mono font-bold uppercase tracking-wider',
          'text-emerald-300 hover:text-white',
          'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 hover:border-emerald-500/70',
          'transition-colors duration-150',
          FOCUS_RING_BUTTON,
        )}
      >
        <LayoutTemplate className="w-3.5 h-3.5" />
        /templates
      </button>
    </div>
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

// Opens the full-screen node-graph view of this char_swap plan (a sibling
// overlay owned by HomePage, mirroring the Trim editor).
function PlanGraphViewButton() {
  const registry = useOptionalCommandRegistry();
  const openGraph = registry?.uiActions.open_plan_flow;
  if (!openGraph) return null;
  return (
    <button
      type="button"
      onClick={() => openGraph()}
      title="Open the node-graph view"
      className={cn(
        'h-8 px-2.5 flex items-center gap-1.5 rounded',
        'text-[10px] font-mono font-bold uppercase tracking-wider',
        'text-emerald-300 hover:text-white',
        'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 hover:border-emerald-500/70',
        'transition-colors duration-150',
        FOCUS_RING_BUTTON,
      )}
    >
      <Share2 className="w-3.5 h-3.5" />
      Graph view
    </button>
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

// Work area for the storyboard_video plan (rendered in /plan). Setup + plan
// creation live in StoryboardSetup (the /templates marketplace). Reads its
// config from the sidecar; per-step storyboard/video generation stays here.
function StoryboardVideoPlanFormula({ sidecar, mediaItems, projectSlug, callTool, onSidecarUpdate }: {
  sidecar: StoryboardVideoPlanSidecar | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: StoryboardVideoPlanSidecar) => void;
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
              'disabled:opacity-50 disabled:cursor-not-allowed',
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

type ToolResult = Awaited<ReturnType<UseMcpResult['callTool']>>;

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

type ImageTileState =
  | { kind: 'missing' } // no image asset attached (gen couldn't be created)
  | { kind: 'generating' }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

// Resolve an OSG's image status from the asset store (never stored in the plan).
// An uploaded image with no live MediaItem still shows via its files path.
function deriveClipShowImageState(assetId: string | null | undefined, mediaItems: MediaItem[], projectSlug: string): ImageTileState {
  if (!assetId) return { kind: 'missing' };
  const item = mediaItems.find((m) => m.id === assetId);
  const fallback = `/files/${projectSlug}/${assetId}/original.jpg`;
  if (!item) return { kind: 'generating' };
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'image gen failed' };
  if (item.status === 'ready') return { kind: 'ready', src: item.thumbnailSrc || item.filePath || fallback };
  return { kind: 'generating' };
}

function clipShowSidecarKey(sidecar: ClipShowPlanSidecar | null): string {
  if (!sidecar) return '';
  return [
    sidecar.character.asset_id,
    sidecar.show_brief,
    sidecar.tone,
    sidecar.segments.map((s) => [
      (s.source_image_asset_ids ?? []).join(','),
      s.joke,
      s.joke_type ?? '',
      s.audio_asset_id ?? '',
      (s.osgs ?? []).map((o) => `${o.source}:${o.image_asset_id ?? ''}:${o.treatment}:${o.caption ?? ''}:${o.duration_ms}`).join('~'),
    ].join(':')).join('|'),
  ].join('|');
}

// True when a clip_show sidecar predates the OSG-run refactor (old segments
// lack an osgs array). Such plans must be regenerated.
function isStaleClipShowPlan(sidecar: ClipShowPlanSidecar): boolean {
  return sidecar.segments.some((s) => !Array.isArray(s.osgs));
}

// Plays each segment's ready voiceover in order — the "read-through". Driven
// imperatively (no effect): handlers + onEnded advance to the next ready track.
function ClipShowReadThroughPlayer({ sidecar, mediaItems, projectSlug }: {
  sidecar: ClipShowPlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
}) {
  const tracks = useMemo(
    () => sidecar.segments.map((s) => {
      const state = deriveClipShowAudioState(s.audio_asset_id, mediaItems, projectSlug);
      return state.kind === 'ready' ? state.src : null;
    }),
    [sidecar.segments, mediaItems, projectSlug],
  );
  const readyCount = tracks.filter(Boolean).length;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);

  const playIndex = useCallback((i: number) => {
    const el = audioRef.current;
    const src = tracks[i] ?? null;
    if (!el || !src) {
      // advance to the next ready track
      for (let j = i + 1; j < tracks.length; j++) {
        if (tracks[j]) { const next = audioRef.current; if (next) { setPlaying(j); next.src = tracks[j] as string; void next.play().catch(() => setPlaying(null)); } return; }
      }
      setPlaying(null);
      return;
    }
    setPlaying(i);
    el.src = src;
    void el.play().catch(() => setPlaying(null));
  }, [tracks]);

  const advance = useCallback((fromInclusive: number) => {
    for (let i = fromInclusive; i < tracks.length; i++) {
      if (tracks[i]) { playIndex(i); return; }
    }
    setPlaying(null);
  }, [tracks, playIndex]);

  const stop = useCallback(() => { setPlaying(null); audioRef.current?.pause(); }, []);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => (playing == null ? advance(0) : stop())}
        disabled={readyCount === 0}
        title={readyCount === 0 ? 'Generate some voiceovers first' : 'Play the jokes in order'}
        className={cn(
          'h-7 px-2.5 flex items-center gap-1.5 rounded',
          'text-[10px] font-mono font-bold uppercase tracking-wider',
          'text-emerald-300 hover:text-white bg-emerald-500/10 hover:bg-emerald-500/20',
          'border border-emerald-500/35 hover:border-emerald-500/60 transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          FOCUS_RING_BUTTON,
        )}
      >
        {playing == null ? <Play className="w-3 h-3" /> : <Square className="w-3 h-3" />}
        {playing == null ? 'Play read-through' : 'Stop'}
      </button>
      <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/40">
        {playing != null ? `playing ${playing + 1}/${sidecar.segments.length}` : `${readyCount}/${sidecar.segments.length} voiced`}
      </span>
      <audio ref={audioRef} onEnded={() => advance((playing ?? -1) + 1)} hidden />
    </div>
  );
}

// Opt-in image generation. Text-to-image is deferred at plan time, so generated
// OSGs land prompt-only; this fills every one that still lacks an image in a
// single call (idempotent server-side). Hidden when the plan has no generated
// OSGs at all; disabled once they're all materialized.
function ClipShowGenerateImagesButton({ sidecar, projectSlug, callTool, onSidecarUpdate }: {
  sidecar: ClipShowPlanSidecar;
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: ClipShowPlanSidecar) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { pending, totalGenerated } = useMemo(() => {
    let pending = 0;
    let totalGenerated = 0;
    for (const s of sidecar.segments) {
      for (const o of s.osgs ?? []) {
        if (o.source !== 'generated') continue;
        totalGenerated++;
        if (!o.image_asset_id && o.image_prompt) pending++;
      }
    }
    return { pending, totalGenerated };
  }, [sidecar.segments]);

  const handleClick = useCallback(async () => {
    setBusy(true);
    try {
      const result = await callTool('generate_clip_show_images', { project_slug: projectSlug });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Image generation failed';
        toast({ title: 'Generate images failed', description: msg, duration: 5000 });
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as { sidecar?: ClipShowPlanSidecar };
        if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
      } catch {
        // sync below reconciles if the result body can't be parsed
      }
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Images enqueued', description: `${pending} OSG image${pending === 1 ? '' : 's'} generating`, duration: 2500 });
    } finally {
      setBusy(false);
    }
  }, [callTool, projectSlug, onSidecarUpdate, pending]);

  if (totalGenerated === 0) return null;
  const disabled = busy || pending === 0;
  return (
    <button
      type="button"
      onClick={() => { void handleClick(); }}
      disabled={disabled}
      title={pending === 0 ? 'All generated OSGs already have images' : `Generate ${pending} OSG image${pending === 1 ? '' : 's'} (text-to-image)`}
      className={cn(
        'h-7 px-2.5 flex items-center gap-1.5 rounded',
        'text-[10px] font-mono font-bold uppercase tracking-wider',
        'text-cyan-200 hover:text-white bg-cyan-500/10 hover:bg-cyan-500/20',
        'border border-cyan-500/35 hover:border-cyan-500/60 transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        FOCUS_RING_BUTTON,
      )}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
      {pending === 0 ? 'Images ready' : `Generate ${pending} image${pending === 1 ? '' : 's'}`}
    </button>
  );
}

// Work area for the clip_show read-through (rendered in /plan). Setup + plan
// creation live in ClipShowSetup (the /templates marketplace); this renders the
// per-item joke segments with their voiceover generation + a play-all control.
function ClipShowWork({ sidecar, mediaItems, projectSlug, callTool, onSidecarUpdate }: {
  sidecar: ClipShowPlanSidecar | null;
  mediaItems: MediaItem[];
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: ClipShowPlanSidecar) => void;
}) {
  if (!sidecar) {
    return (
      <div className="rounded border border-dashed border-emerald-500/25 bg-zinc-950/40 p-6 text-center">
        <Mic className="w-6 h-6 mx-auto mb-2 text-emerald-300/40" />
        <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-300/45">
          read-through plan not generated yet
        </div>
      </div>
    );
  }
  if (isStaleClipShowPlan(sidecar)) {
    return (
      <div className="rounded border border-dashed border-amber-500/30 bg-amber-500/5 p-6 text-center space-y-2">
        <Mic className="w-6 h-6 mx-auto text-amber-300/50" />
        <div className="text-[11px] font-mono uppercase tracking-wider text-amber-300/70">old clip show format</div>
        <p className="text-[11px] font-mono text-amber-200/60 leading-relaxed">
          This plan predates the read-through update. Open <span className="text-amber-200/90">Templates</span> above and regenerate Clip Show.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800/60 pb-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/45">
          {sidecar.segments.length} joke{sidecar.segments.length === 1 ? '' : 's'} planned
        </div>
        <div className="flex items-center gap-2">
          <ClipShowGenerateImagesButton sidecar={sidecar} projectSlug={projectSlug} callTool={callTool} onSidecarUpdate={onSidecarUpdate} />
          <ClipShowReadThroughPlayer sidecar={sidecar} mediaItems={mediaItems} projectSlug={projectSlug} />
        </div>
      </div>
      {sidecar.segments.map((segment, index) => (
        <ClipShowSegmentBlock
          key={index}
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

// Ordered pool of img-* images dropped for a Clip Show. The model groups these
// into jokes and lays out each joke's OSG run. Reorder/remove inline.
function ClipShowItemsEditor({ imageAssetIds, mediaItems, onChange }: {
  imageAssetIds: string[];
  mediaItems: MediaItem[];
  onChange: (next: string[]) => void;
}) {
  const [dragActive, setDragActive] = useState(false);

  const addImage = (assetId: string) => {
    if (!assetId.startsWith('img-')) {
      toast({ title: 'Wrong asset type', description: `Drop an img-* image, got ${assetId}.`, duration: 3000 });
      return;
    }
    if (imageAssetIds.includes(assetId)) return;
    onChange([...imageAssetIds, assetId]);
  };
  const removeAt = (i: number) => onChange(imageAssetIds.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= imageAssetIds.length) return;
    const next = [...imageAssetIds];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      if (typeof payload.id === 'string') addImage(payload.id);
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
        <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">Image pool</div>
        <div className="text-[10px] font-mono text-emerald-300/40">{imageAssetIds.length > 0 ? `${imageAssetIds.length} image${imageAssetIds.length === 1 ? '' : 's'}` : 'drop img-*'}</div>
      </div>
      {imageAssetIds.length === 0 ? (
        <div className="h-20 rounded bg-zinc-950/70 border border-zinc-800/70 flex flex-col items-center justify-center gap-1.5">
          <Images className="w-5 h-5 text-emerald-300/35" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/45">drop img-* here</span>
        </div>
      ) : (
        <ol className="space-y-1.5">
          {imageAssetIds.map((id, index) => {
            const imageItem = mediaItems.find((m) => m.id === id) ?? null;
            const src = imageItem?.thumbnailSrc ?? imageItem?.filePath ?? null;
            return (
              <li
                key={`${id}-${index}`}
                className="flex items-center gap-2 rounded border border-zinc-700/60 bg-zinc-950/75 p-1.5"
              >
                <span className="shrink-0 w-5 text-center text-[10px] font-mono text-emerald-300/45">{index + 1}</span>
                <span className="shrink-0 h-9 w-14 rounded bg-black/40 border border-zinc-800/70 overflow-hidden flex items-center justify-center">
                  {src ? <img src={src} alt={id} className="w-full h-full object-contain" loading="lazy" /> : <Images className="w-3.5 h-3.5 text-emerald-300/40" />}
                </span>
                <span className="min-w-0 flex-1 text-[11px] font-mono text-emerald-200/75 truncate">{imageItem?.slug ?? `@${id}`}</span>
                <div className="ml-auto flex items-center gap-0.5 shrink-0">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} title="Move up" className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:bg-emerald-500/15 disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING_BUTTON)}><ArrowUp className="w-3 h-3" /></button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === imageAssetIds.length - 1} title="Move down" className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:bg-emerald-500/15 disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING_BUTTON)}><ArrowDown className="w-3 h-3" /></button>
                  <button type="button" onClick={() => removeAt(index)} title="Remove" className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:border-red-300/70 hover:bg-red-500/25', FOCUS_RING_BUTTON)}><X className="w-3 h-3" /></button>
                </div>
              </li>
            );
          })}
        </ol>
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
              'disabled:opacity-50 disabled:cursor-not-allowed',
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
  const [joke, setJoke] = useState(segment.joke);
  const [jokeType, setJokeType] = useState(segment.joke_type ?? DEFAULT_JOKE_TYPE);
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [sourceDragActive, setSourceDragActive] = useState(false);
  const audioState = useMemo(
    () => deriveClipShowAudioState(segment.audio_asset_id, mediaItems, projectSlug),
    [segment.audio_asset_id, mediaItems, projectSlug],
  );

  useEffect(() => {
    setJoke(segment.joke);
  }, [segment.joke]);
  useEffect(() => {
    setJokeType(segment.joke_type ?? DEFAULT_JOKE_TYPE);
  }, [segment.joke_type]);

  // Apply a tool result that returns the full updated plan sidecar.
  const applyResult = useCallback((result: ToolResult, failTitle: string): boolean => {
    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? `${failTitle} failed`;
      toast({ title: failTitle, description: msg, duration: 5000 });
      return false;
    }
    try {
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { sidecar?: ClipShowPlanSidecar };
      if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
    } catch {
      return false;
    }
    return true;
  }, [onSidecarUpdate]);

  // Structural plan edit (op-based, GPT-free): joke text, audio, and all OSG ops.
  const editPlan = useCallback(async (args: Record<string, unknown>): Promise<boolean> => {
    const result = await callTool('replace_plan_clip_show_asset', {
      project_slug: projectSlug,
      segment_index: index,
      ...args,
    });
    return applyResult(result, 'Clip Show update');
  }, [callTool, projectSlug, index, applyResult]);

  // Regenerate one OSG's image (new img-* asset + enqueued t2i job).
  const regenOsgImage = useCallback(async (osgIndex: number, opts?: { image_prompt?: string; treatment?: string }): Promise<boolean> => {
    const result = await callTool('regenerate_clip_show_osg', {
      project_slug: projectSlug,
      segment_index: index,
      osg_index: osgIndex,
      ...opts,
    });
    return applyResult(result, 'OSG regenerate');
  }, [callTool, projectSlug, index, applyResult]);

  // Rewrite this joke and its whole OSG run via GPT-5.5, optionally adding a
  // dropped-in img-* to the joke's source pool. Returns the full updated plan
  // (stale voiceover cleared, generated OSG images re-enqueued).
  const handleRegenerate = useCallback(async (opts?: { imageAssetId?: string }) => {
    setRegenerating(true);
    try {
      const result = await callTool('regenerate_clip_show_segment', {
        project_slug: projectSlug,
        segment_index: index,
        joke_type: jokeType,
        ...(opts?.imageAssetId ? { image_asset_id: opts.imageAssetId } : {}),
      });
      applyResult(result, 'Regenerate');
    } finally {
      setRegenerating(false);
    }
  }, [callTool, projectSlug, index, jokeType, applyResult]);

  const handleSourceDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setSourceDragActive(false);
    if (regenerating) return;
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      const droppedId = payload.id;
      if (typeof droppedId !== 'string') return;
      if (!droppedId.startsWith('img-')) {
        toast({ title: 'Not an image', description: `Drop an img-* to add a source, got ${droppedId}.`, duration: 3000 });
        return;
      }
      if (segment.source_image_asset_ids.includes(droppedId)) return;
      void handleRegenerate({ imageAssetId: droppedId });
    } catch {
      return;
    }
  }, [regenerating, segment.source_image_asset_ids, handleRegenerate]);

  const handleGenerateAudio = useCallback(async () => {
    if (!joke.trim()) return;
    setGeneratingAudio(true);
    try {
      const saved = await editPlan({ op: 'set_joke', joke: joke.trim() });
      if (!saved) return;
      const result = await callTool('generate_elevenlabs_t2a', {
        project_slug: projectSlug,
        character_asset_id: sidecar.character.asset_id,
        text: joke.trim(),
        asset_name: `clip-show-s${index + 1}`,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'ElevenLabs generation failed';
        toast({ title: 'Audio generation failed', description: msg, duration: 5000 });
        return;
      }
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { aud_asset_id?: string };
      if (parsed.aud_asset_id) await editPlan({ op: 'set_audio', audio_asset_id: parsed.aud_asset_id });
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Audio enqueued', description: sidecar.character.elevenlabs_voice_id, duration: 2500 });
    } finally {
      setGeneratingAudio(false);
    }
  }, [joke, editPlan, callTool, projectSlug, sidecar.character.asset_id, sidecar.character.elevenlabs_voice_id, index]);

  const handleAudioReplace = useCallback(async (assetId: string) => {
    await editPlan({ op: 'set_audio', audio_asset_id: assetId });
  }, [editPlan]);

  const canGenerateAudio = joke.trim().length > 0 && !generatingAudio && !regenerating;

  return (
    <section className="min-w-0 overflow-hidden rounded border border-emerald-500/20 bg-zinc-950/55">
      <header className="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-emerald-500/15 bg-black/45">
        <div className="min-w-0 flex items-center gap-2 font-mono">
          <span className="inline-flex w-6 h-6 shrink-0 items-center justify-center rounded-full border border-emerald-500/45 bg-emerald-500/10 text-emerald-200 text-[11px] font-bold">{index + 1}</span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-200 truncate">Joke {index + 1}</h2>
            <div className="text-[10px] uppercase tracking-wider text-emerald-300/40 truncate">{segment.osgs.length} OSG{segment.osgs.length === 1 ? '' : 's'}</div>
          </div>
        </div>
        <div className="text-[10px] font-mono text-emerald-300/45">GPT-5.5</div>
      </header>
      <div className="min-w-0 p-3 space-y-3">
        <ClipShowOsgStrip
          segment={segment}
          mediaItems={mediaItems}
          projectSlug={projectSlug}
          onEdit={editPlan}
          onRegenOsg={regenOsgImage}
          disabled={regenerating}
        />

        <div className="min-w-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_16rem] gap-3">
          <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">Joke</div>
              <div className="flex items-center gap-1.5">
                <select
                  value={jokeType}
                  onChange={(e) => setJokeType(e.target.value)}
                  disabled={regenerating}
                  title="Joke type — applied when you regenerate"
                  className="h-6 px-1.5 rounded bg-black/60 border border-zinc-700 text-[10px] font-mono text-emerald-200/90 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {CLIP_SHOW_JOKE_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => { void handleRegenerate(); }}
                  disabled={regenerating}
                  title="Rewrite this joke and its OSG run with GPT-5.5 in the selected type"
                  className={cn(
                    'h-6 px-2 flex items-center gap-1 rounded text-[10px] font-mono uppercase tracking-wider',
                    'text-emerald-300/80 hover:text-emerald-300',
                    'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    FOCUS_RING_BUTTON,
                  )}
                >
                  {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Regenerate
                </button>
              </div>
            </div>
            <PromptEditor value={joke} onChange={setJoke} mediaItems={mediaItems} projectSlug={projectSlug} />
            {segment.joke_notes && (
              <div className="text-[10px] font-mono text-emerald-300/40 leading-relaxed">{segment.joke_notes}</div>
            )}
            <div
              className={cn(
                'flex items-center gap-1.5 flex-wrap pt-2 border-t border-zinc-800/60 rounded transition-colors',
                sourceDragActive ? 'bg-emerald-500/10' : '',
              )}
              onDragEnter={(e) => { e.preventDefault(); setSourceDragActive(true); }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setSourceDragActive(true); }}
              onDragLeave={(e) => { e.preventDefault(); setSourceDragActive(false); }}
              onDrop={handleSourceDrop}
            >
              <span className="text-[9px] font-mono uppercase tracking-wider text-cyan-300/55">Sources</span>
              {segment.source_image_asset_ids.length === 0 ? (
                <span className="text-[9px] font-mono text-emerald-300/35">none</span>
              ) : (
                segment.source_image_asset_ids.map((id) => {
                  const slug = mediaItems.find((m) => m.id === id)?.slug ?? `@${id}`;
                  return <span key={id} className="rounded bg-black/50 border border-zinc-700/60 px-1.5 py-0.5 text-[9px] font-mono text-emerald-200/70 truncate max-w-[10rem]">{slug}</span>;
                })
              )}
              <span className="ml-auto text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">drop img-* to add + regen</span>
            </div>
          </div>

          <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-300/55">Voiceover</div>
              <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">host reads the joke</div>
            </div>
            <ClipShowAudioSlot
              state={audioState}
              assetId={segment.audio_asset_id ?? null}
              generating={generatingAudio}
              disabled={!canGenerateAudio}
              disabledReason="Joke required"
              onGenerate={() => { void handleGenerateAudio(); }}
              onReplace={(assetId) => { void handleAudioReplace(assetId); }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// The ordered OSG run for one joke: a horizontal filmstrip of cards plus a
// drop-to-add tile. Each card edits/regenerates a single graphic.
function ClipShowOsgStrip({ segment, mediaItems, projectSlug, onEdit, onRegenOsg, disabled }: {
  segment: ClipShowSegment;
  mediaItems: MediaItem[];
  projectSlug: string;
  onEdit: (args: Record<string, unknown>) => Promise<boolean>;
  onRegenOsg: (osgIndex: number, opts?: { image_prompt?: string; treatment?: string }) => Promise<boolean>;
  disabled: boolean;
}) {
  const [addDragActive, setAddDragActive] = useState(false);
  const handleAddDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setAddDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      const id = payload.id;
      if (typeof id !== 'string') return;
      if (!id.startsWith('img-')) {
        toast({ title: 'Not an image', description: `Drop an img-* to add an OSG, got ${id}.`, duration: 3000 });
        return;
      }
      void onEdit({ op: 'add_osg', image_asset_id: id, treatment: 'photo' });
    } catch {
      return;
    }
  };
  return (
    <div className="min-w-0 rounded border border-zinc-800/70 bg-black/35 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-300/60">OSG run · {segment.osgs.length}</div>
        <div className="text-[9px] font-mono uppercase tracking-wider text-emerald-300/30">drop img-* on a card to swap</div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {segment.osgs.map((osg, i) => (
          <ClipShowOsgCard
            key={i}
            osg={osg}
            osgIndex={i}
            total={segment.osgs.length}
            mediaItems={mediaItems}
            projectSlug={projectSlug}
            onEdit={onEdit}
            onRegen={onRegenOsg}
            disabled={disabled}
          />
        ))}
        <div
          className={cn(
            'shrink-0 w-24 self-stretch min-h-[12rem] rounded border border-dashed flex flex-col items-center justify-center gap-1 transition-colors',
            addDragActive ? 'border-emerald-300 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700/70 text-emerald-300/45',
          )}
          onDragEnter={(e) => { e.preventDefault(); setAddDragActive(true); }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setAddDragActive(true); }}
          onDragLeave={(e) => { e.preventDefault(); setAddDragActive(false); }}
          onDrop={handleAddDrop}
          title="Drop an img-* to add a card"
        >
          <Plus className="w-4 h-4" />
          <span className="text-[9px] font-mono uppercase tracking-wider text-center px-1">drop img-* to add</span>
        </div>
      </div>
    </div>
  );
}

// One on-screen graphic: image (with live status), treatment, caption,
// duration, reorder/regenerate/edit-prompt/delete controls. Drop an img-* to
// swap the backing image to an upload.
function ClipShowOsgCard({ osg, osgIndex, total, mediaItems, projectSlug, onEdit, onRegen, disabled }: {
  osg: ClipShowOsg;
  osgIndex: number;
  total: number;
  mediaItems: MediaItem[];
  projectSlug: string;
  onEdit: (args: Record<string, unknown>) => Promise<boolean>;
  onRegen: (osgIndex: number, opts?: { image_prompt?: string; treatment?: string }) => Promise<boolean>;
  disabled: boolean;
}) {
  const [caption, setCaption] = useState(osg.caption ?? '');
  const [duration, setDuration] = useState(String(osg.duration_ms));
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [prompt, setPrompt] = useState(osg.image_prompt ?? '');
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => { setCaption(osg.caption ?? ''); }, [osg.caption]);
  useEffect(() => { setDuration(String(osg.duration_ms)); }, [osg.duration_ms]);
  useEffect(() => { setPrompt(osg.image_prompt ?? ''); }, [osg.image_prompt]);

  const imageState = useMemo(
    () => deriveClipShowImageState(osg.image_asset_id, mediaItems, projectSlug),
    [osg.image_asset_id, mediaItems, projectSlug],
  );

  const run = useCallback(async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  }, []);

  const busyAll = busy || disabled;
  const canRegen = osg.source === 'generated' || !!osg.image_prompt;

  const commitCaption = () => {
    const next = caption.trim();
    if (next === (osg.caption ?? '')) return;
    void run(() => onEdit({ op: 'set_osg_field', osg_index: osgIndex, caption: next || null }));
  };
  const commitDuration = () => {
    const n = Number(duration);
    if (!Number.isFinite(n) || Math.round(n) === osg.duration_ms) { setDuration(String(osg.duration_ms)); return; }
    void run(() => onEdit({ op: 'set_osg_field', osg_index: osgIndex, duration_ms: Math.round(n) }));
  };
  const swapDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const json = e.dataTransfer.getData('application/json');
    if (!json) return;
    try {
      const payload = JSON.parse(json) as SidebarDragPayload;
      const id = payload.id;
      if (typeof id !== 'string') return;
      if (!id.startsWith('img-')) {
        toast({ title: 'Not an image', description: `Drop an img-* to swap, got ${id}.`, duration: 3000 });
        return;
      }
      if (id === osg.image_asset_id) return;
      void run(() => onEdit({ op: 'swap_osg_image', osg_index: osgIndex, image_asset_id: id }));
    } catch {
      return;
    }
  };

  return (
    <div className="shrink-0 w-44 rounded border border-zinc-700/60 bg-zinc-950/70 p-2 space-y-1.5">
      <div
        className={cn(
          'relative h-24 rounded bg-black/40 border overflow-hidden flex items-center justify-center transition-colors',
          dragActive ? 'border-emerald-300 ring-1 ring-emerald-300/40' : 'border-zinc-800/70',
        )}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDrop={swapDrop}
        title="Drop an img-* to swap this card's image"
      >
        {imageState.kind === 'ready' ? (
          <img src={imageState.src} alt={osg.beat_text} className="w-full h-full object-cover" loading="lazy" />
        ) : imageState.kind === 'generating' ? (
          <Loader2 className="w-5 h-5 animate-spin text-emerald-300/70" />
        ) : imageState.kind === 'error' ? (
          <span className="text-[9px] font-mono text-red-200/80 px-1 text-center line-clamp-3">{imageState.message}</span>
        ) : osg.source === 'generated' ? (
          <div className="flex flex-col items-center gap-0.5 text-cyan-300/45">
            <Sparkles className="w-5 h-5" />
            <span className="text-[8px] font-mono uppercase tracking-wider">not generated</span>
          </div>
        ) : (
          <Images className="w-5 h-5 text-emerald-300/35" />
        )}
        <span className="absolute top-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/70 px-1 py-0.5 text-[8px] font-mono uppercase tracking-wider text-emerald-200/80">
          {osg.source === 'generated' ? <Sparkles className="w-2.5 h-2.5" /> : <Images className="w-2.5 h-2.5" />}
          {osg.source === 'generated' ? 'gen' : 'up'}
        </span>
        <span className="absolute top-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[8px] font-mono text-emerald-200/70">{osgIndex + 1}</span>
        {busyAll && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-300/80" />
          </div>
        )}
      </div>

      <select
        value={osg.treatment}
        disabled={busyAll}
        onChange={(e) => void run(() => onEdit({ op: 'set_osg_field', osg_index: osgIndex, treatment: e.target.value }))}
        title="Treatment"
        className="w-full h-6 px-1 rounded bg-black/60 border border-zinc-700 text-[10px] font-mono text-emerald-200/90 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50"
      >
        {CLIP_SHOW_TREATMENTS.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>

      <input
        value={caption}
        disabled={busyAll}
        onChange={(e) => setCaption(e.target.value)}
        onBlur={commitCaption}
        placeholder="caption…"
        className="w-full h-6 px-1.5 rounded bg-black/60 border border-zinc-700 text-[10px] font-mono text-emerald-100/90 placeholder:text-emerald-300/25 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50"
      />

      <div className="flex items-center gap-1">
        <input
          value={duration}
          disabled={busyAll}
          onChange={(e) => setDuration(e.target.value)}
          onBlur={commitDuration}
          inputMode="numeric"
          title="Hold duration (ms)"
          className="w-14 h-6 px-1.5 rounded bg-black/60 border border-zinc-700 text-[10px] font-mono text-emerald-100/90 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50"
        />
        <span className="text-[9px] font-mono text-emerald-300/40">ms</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" disabled={busyAll || osgIndex === 0} title="Move left" onClick={() => void run(() => onEdit({ op: 'reorder_osg', osg_index: osgIndex, to_index: osgIndex - 1 }))} className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:bg-emerald-500/15 disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING_BUTTON)}><ArrowLeft className="w-3 h-3" /></button>
          <button type="button" disabled={busyAll || osgIndex === total - 1} title="Move right" onClick={() => void run(() => onEdit({ op: 'reorder_osg', osg_index: osgIndex, to_index: osgIndex + 1 }))} className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:bg-emerald-500/15 disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING_BUTTON)}><ArrowRight className="w-3 h-3" /></button>
        </div>
      </div>

      <div className="text-[9px] font-mono text-emerald-300/40 leading-snug line-clamp-2" title={osg.beat_text}>{osg.beat_text || '—'}</div>

      {editingPrompt && (
        <div className="space-y-1">
          <textarea
            value={prompt}
            disabled={busyAll}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="image prompt…"
            className="w-full px-1.5 py-1 rounded bg-black/60 border border-zinc-700 text-[10px] font-mono text-emerald-100/90 placeholder:text-emerald-300/25 focus:outline-none focus:border-emerald-500/60 disabled:opacity-50"
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busyAll || !prompt.trim()}
              title="Generate from this prompt"
              onClick={() => void run(async () => {
                const ok = await onRegen(osgIndex, { image_prompt: prompt.trim() });
                if (ok) setEditingPrompt(false);
                return ok;
              })}
              className={cn('h-6 px-2 flex items-center gap-1 rounded text-[10px] font-mono uppercase tracking-wider text-emerald-300/80 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 hover:border-emerald-500/60 disabled:opacity-50 disabled:cursor-not-allowed', FOCUS_RING_BUTTON)}
            >
              <Sparkles className="w-3 h-3" /> Generate
            </button>
            <button type="button" onClick={() => { setEditingPrompt(false); setPrompt(osg.image_prompt ?? ''); }} className="h-6 px-2 rounded text-[10px] font-mono uppercase tracking-wider text-emerald-300/50 hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-0.5 pt-0.5 border-t border-zinc-800/60">
        {canRegen && (
          <button type="button" disabled={busyAll} title="Regenerate this image" onClick={() => void run(() => onRegen(osgIndex))} className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:bg-emerald-500/15 disabled:opacity-40', FOCUS_RING_BUTTON)}><RefreshCw className="w-3 h-3" /></button>
        )}
        <button type="button" disabled={busyAll} title="Edit image prompt" onClick={() => setEditingPrompt((v) => !v)} className={cn('h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-white hover:bg-emerald-500/15 disabled:opacity-40', FOCUS_RING_BUTTON)}><Pencil className="w-3 h-3" /></button>
        <button type="button" disabled={busyAll || total <= 1} title={total <= 1 ? 'A joke needs at least one OSG' : 'Delete this card'} onClick={() => void run(() => onEdit({ op: 'remove_osg', osg_index: osgIndex }))} className={cn('ml-auto h-6 w-6 rounded flex items-center justify-center text-emerald-300/55 hover:text-red-200 hover:bg-red-500/25 disabled:opacity-30 disabled:cursor-not-allowed', FOCUS_RING_BUTTON)}><X className="w-3 h-3" /></button>
      </div>
    </div>
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

// Per-scene clip + audio live as sibling files inside the `plan` asset
// (stamped into `.plan.json` by /plan-vis as `clip_filename` / `audio_filename`,
// e.g. "s1.mp4" / "s1.mp3"). The render path addresses them via the
// `@plan/<filename>` slug form the seedance/kie resolvers learned. PLAN_ASSET_ID
// and the swap/video model layer now live in ./plan/charSwapModel.
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

  // Per-scene clip/audio bootstrap (even_split + extract_audio). Lifted into a
  // shared, module-deduped hook so the graph editor — which the template flow
  // opens directly, without ever mounting this scene list — runs it too. Gates
  // RUN VIDEO per scene; otherwise seedance would get a half-written reference.
  const sceneFilesReady = useSceneFilesBootstrap({ projectSlug, sidecar: data, callTool });

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

type ReplaceSource =
  | { kind: 'file'; file: File }
  | { kind: 'asset'; assetId: string };

interface SidebarDragPayload {
  slug?: string;
  id?: string;
  type?: string;
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
    // Grok Imagine can voice the swapped characters, so seed its prompt with the
    // scene's transcribed dialog (skip the no-speech placeholder). Seedance seeds
    // stay the bare visual.
    const dialog = (scene.dialog ?? '').trim();
    const grokSeed = dialog.length > 0 && dialog !== '(no speech in this chunk)'
      ? `${seed}\n\nDialogue: ${dialog}`
      : seed;
    return { 'seedance-2-ref': seed, 'seedance-2-fast': seed, 'grok-imagine-1-5': grokSeed };
  });
  const [selectedVideoModel, setSelectedVideoModel] = useState<VideoModel>('seedance-2-ref');
  const isGrokVideo = selectedVideoModel === 'grok-imagine-1-5';
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

  const videoGate = useMemo(
    () => isGrokVideo ? grokVideoReadyForGen(scene, tile1) : videoReadyForGen(scene, tile1, tile2),
    [isGrokVideo, scene, tile1, tile2],
  );

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
    const isGrok = selectedVideoModel === 'grok-imagine-1-5';
    const toolArgs = isGrok
      ? buildGrokImagineToolArgs(scene, characters, sceneAudioSlug, videoModelPrompts[selectedVideoModel], sourceAspect)
      : buildSeedanceToolArgs(scene, characters, mediaItems, sceneClipSlug, sceneAudioSlug, videoModelPrompts[selectedVideoModel], sourceAspect);
    if (!toolArgs) {
      toast({
        title: `Scene ${index + 1}`,
        description: 'Generate the first-frame swap before running Grok Imagine.',
        duration: 4000,
      });
      return;
    }
    setSubmittingVideo(true);
    try {
      const toolName = TOOL_BY_VIDEO_MODEL[selectedVideoModel];
      const result = await callTool(toolName, {
        project_slug: projectSlug,
        ...toolArgs,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? `Failed to enqueue ${LABEL_BY_VIDEO_MODEL[selectedVideoModel]}`;
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
      const modelLabel = LABEL_BY_VIDEO_MODEL[selectedVideoModel];
      const note = isGrok
        ? `${modelLabel} (kie) · 720p · first frame + refs`
        : swapsReady
          ? `${modelLabel} (kie) · 720p · swapped frames`
          : `${modelLabel} (kie) · 720p · char refs`;
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
  // Grok i2v animates from the first-frame swap alone; Seedance interpolates and
  // needs both frames. Drives the step dimming + disabled gate per selected model.
  const videoStepReady = isGrokVideo ? tile1.kind === 'ready' : bothReady;
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
        bothReady={videoStepReady}
        selectedModel={selectedVideoModel}
        onSelectModel={setSelectedVideoModel}
        prompt={videoModelPrompts[selectedVideoModel]}
        onPromptChange={setSelectedVideoPrompt}
        payload={videoPayload}
        mediaItems={mediaItems}
        sourceAspect={sourceAspect}
        projectSlug={projectSlug}
        disabled={!videoStepReady || !videoGate.ok || anySwapInFlight || !sceneSourceReady || submittingVideo}
        disabledReason={
          !videoStepReady
            ? (isGrokVideo ? 'Waiting on the first-frame swap' : 'Both swap frames must finish generating')
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
function VideoStepBlock({ bothReady, selectedModel, ...rest }: {
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
            {selectedModel === 'grok-imagine-1-5' ? '(waiting for first-frame swap)' : '(waiting for both swap frames)'}
          </span>
        )}
      </div>
      <div className={cn(!bothReady && 'opacity-50 pointer-events-none')}>
        <VideoPanel selectedModel={selectedModel} {...rest} />
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

// Exported for the flow-canvas node JSON flip (Phase 3). Renders a payload with
// inline @img-/@vid-/@aud-/@plan thumbnails via renderJsonLine.
export function PayloadJsonView({ payload, mediaItems, projectSlug }: {
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

// ── Template setup panels (rendered inside the /templates marketplace preview) ──
// Each owns the per-formula config inputs + the Generate handler. On success the
// new plan sidecar has landed (synchronous for storyboard; polled for the two
// enqueued formulas), so `onGenerated()` navigates to /plan to work on it.

export interface PlanTemplateSetupProps {
  projectSlug: string;
  mediaItems: MediaItem[];
  callTool: UseMcpResult['callTool'];
  onGenerated: () => void;
}

// Load the current plan sidecar once so a setup panel can pre-fill from an
// existing plan of the same formula. Loading is gated so useState initializers
// (not effects) can seed from it.
function useCurrentSidecar(projectSlug: string, callTool: UseMcpResult['callTool']) {
  const [state, setState] = useState<{ loading: boolean; sidecar: AnyPlanSidecar | null }>({ loading: true, sidecar: null });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Flip to loading inside the async closure so the effect body stays
      // setState-free (react-hooks/set-state-in-effect).
      setState({ loading: true, sidecar: null });
      const result = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelled) return;
      if (result.isError) { setState({ loading: false, sidecar: null }); return; }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        setState({ loading: false, sidecar: JSON.parse(text) as AnyPlanSidecar });
      } catch {
        setState({ loading: false, sidecar: null });
      }
    })();
    return () => { cancelled = true; };
  }, [projectSlug, callTool]);
  return state;
}

function SetupLoading() {
  return (
    <div className="min-h-[30vh] flex items-center justify-center">
      <Loader2 className="w-5 h-5 animate-spin text-emerald-400/60" />
    </div>
  );
}

const USE_TEMPLATE_BTN = cn(
  'h-11 px-6 flex items-center justify-center gap-2.5 rounded-md',
  'text-sm font-mono font-bold uppercase tracking-wider',
  'text-emerald-950 bg-emerald-400 hover:bg-emerald-300',
  'border border-emerald-300/60',
  'shadow-[0_0_22px_rgba(52,211,153,0.28)] hover:shadow-[0_0_30px_rgba(52,211,153,0.45)]',
  'transition-all duration-150',
  'disabled:bg-emerald-500/15 disabled:text-emerald-300/55 disabled:border-emerald-500/30 disabled:shadow-none disabled:cursor-not-allowed',
  FOCUS_RING_BUTTON,
);

// Big primary call-to-action at the top of every setup panel. Auto-picked inputs
// keep `canGenerate` true on any project with the right assets, so this needs no
// configuration; when assets are missing it disables with a hint pointing to Customize.
function UseTemplateCTA({ generating, canGenerate, onUse, icon, hint }: {
  generating: boolean;
  canGenerate: boolean;
  onUse: () => void;
  icon: React.ReactNode;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <button
        type="button"
        onClick={onUse}
        disabled={generating || !canGenerate}
        title={canGenerate ? 'Use this template' : hint}
        className={USE_TEMPLATE_BTN}
      >
        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
        {generating ? 'Generating…' : 'Use Template'}
      </button>
      {!canGenerate && !generating && <span className="text-[11px] font-mono text-emerald-300/45">{hint}</span>}
    </div>
  );
}

// Collapsed disclosure holding a setup panel's input controls (drop zones,
// briefs, model/duration). Hidden by default so the preview stays a showcase;
// editing here overrides the auto-picked seeds the CTA generates from.
function CustomizeInputs({ children }: { children: React.ReactNode }) {
  return (
    <details className="group rounded border border-zinc-800/70 bg-black/25">
      <summary className={cn(
        'flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden',
        'text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-300/55 hover:text-emerald-200',
      )}>
        <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90" />
        Customize inputs
      </summary>
      <div className="px-3 pb-3 pt-1">
        {children}
      </div>
    </details>
  );
}

export function CharSwapSetup({ projectSlug, mediaItems, callTool }: PlanTemplateSetupProps) {
  const { loading, sidecar } = useCurrentSidecar(projectSlug, callTool);
  if (loading) return <SetupLoading />;
  return (
    <CharSwapSetupInner
      projectSlug={projectSlug}
      mediaItems={mediaItems}
      callTool={callTool}
      initial={planFormula(sidecar) === 'char_swap' ? (sidecar as PlanSidecar) : null}
    />
  );
}

function CharSwapSetupInner({ projectSlug, mediaItems, callTool, initial }: Omit<PlanTemplateSetupProps, 'onGenerated'> & { initial: PlanSidecar | null }) {
  // Seed from the existing plan, else auto-pick the project's newest assets so
  // the inputs come pre-filled.
  const autoPick = initial ? null : autoPickCharSwap(mediaItems);
  const [sourceId, setSourceId] = useState<string | null>(initial?.source_asset_id ?? autoPick?.sourceId ?? null);
  const [charAId, setCharAId] = useState<string | null>(initial?.characters[0]?.asset_id ?? autoPick?.charAId ?? null);
  const [charBId, setCharBId] = useState<string | null>(initial?.characters[1]?.asset_id ?? autoPick?.charBId ?? null);
  const [generating, setGenerating] = useState(false);
  const cancelledRef = useRef(false);
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);

  const registry = useOptionalCommandRegistry();
  const openGraph = registry?.uiActions.open_plan_flow;

  const sourceItem = useMemo(() => (sourceId ? mediaItems.find((m) => m.id === sourceId) ?? null : null), [sourceId, mediaItems]);
  const charAItem = useMemo(() => (charAId ? mediaItems.find((m) => m.id === charAId) ?? null : null), [charAId, mediaItems]);
  const charBItem = useMemo(() => (charBId ? mediaItems.find((m) => m.id === charBId) ?? null : null), [charBId, mediaItems]);
  const sourceAspect = useMemo(() => sourceAspectFromDimensions(sourceItem?.width, sourceItem?.height), [sourceItem?.width, sourceItem?.height]);

  const canGenerate = Boolean(sourceId && charAId && charBId) && charAId !== charBId;

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
      // plan_visualization runs in the background (vision + ffmpeg). The graph
      // is char_swap's sole surface — open it now and let it poll for scenes.
      openGraph?.();
    } finally {
      if (!cancelledRef.current) setGenerating(false);
    }
  }, [canGenerate, sourceId, charAId, charBId, projectSlug, callTool, openGraph]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <PlanHeaderSlot label="Video Source" kind="source" item={sourceItem} sourceAspect={sourceAspect} onDrop={setSourceId} />
        <PlanHeaderSlot label="Char A" kind="character" item={charAItem} onDrop={setCharAId} />
        <PlanHeaderSlot label="Char B" kind="character" item={charBItem} onDrop={setCharBId} />
      </div>
      <UseTemplateCTA
        generating={generating}
        canGenerate={canGenerate}
        onUse={() => { void handleGenerate(); }}
        icon={<MapPin className="w-4 h-4" />}
        hint="Pick a transcribed video + two distinct subjects"
      />
    </div>
  );
}

export function StoryboardSetup({ projectSlug, mediaItems, callTool, onGenerated }: PlanTemplateSetupProps) {
  const { loading, sidecar } = useCurrentSidecar(projectSlug, callTool);
  if (loading) return <SetupLoading />;
  return (
    <StoryboardSetupInner
      projectSlug={projectSlug}
      mediaItems={mediaItems}
      callTool={callTool}
      onGenerated={onGenerated}
      initial={isStoryboardVideoPlan(sidecar) ? sidecar : null}
    />
  );
}

function StoryboardSetupInner({ projectSlug, mediaItems, callTool, onGenerated, initial }: PlanTemplateSetupProps & { initial: StoryboardVideoPlanSidecar | null }) {
  // Seed from the existing plan, else auto-pick the newest source image so
  // "Use Template" works without opening Customize.
  const [sourceImageIds, setSourceImageIds] = useState<string[]>(
    () => (initial ? storyboardSourceImageIds(initial) : autoPickStoryboard(mediaItems).sourceImageIds),
  );
  const [storyboardBrief, setStoryboardBrief] = useState(initial?.storyboard_brief ?? '');
  const [loopVideo, setLoopVideo] = useState(initial?.loop_video ?? false);
  const [durationS, setDurationS] = useState(initial?.duration_s ?? 15);
  const [selectedVideoModel, setSelectedVideoModel] = useState<VideoModel>(videoModelFromTool(initial?.video_model));
  const [generating, setGenerating] = useState(false);

  const sourceItems = useMemo(
    () => sourceImageIds.map((id) => ({ id, item: mediaItems.find((m) => m.id === id) ?? null })),
    [sourceImageIds, mediaItems],
  );

  const handleSourceDrop = useCallback((assetId: string) => {
    if (!assetId.startsWith('img-')) {
      toast({ title: 'Wrong asset type', description: `Drop an img-* source image, got ${assetId}.`, duration: 3000 });
      return;
    }
    setSourceImageIds((prev) => (prev.includes(assetId) ? prev : [...prev, assetId]));
  }, []);
  const handleSourceRemove = useCallback((assetId: string) => {
    setSourceImageIds((prev) => (prev.length <= 1 ? prev : prev.filter((id) => id !== assetId)));
  }, []);
  const handleSourcePromote = useCallback((assetId: string) => {
    setSourceImageIds((prev) => (prev[0] === assetId ? prev : [assetId, ...prev.filter((id) => id !== assetId)]));
  }, []);

  const canGenerate = sourceImageIds.length > 0 && !generating;

  const handleGenerate = useCallback(async () => {
    if (sourceImageIds.length === 0 || generating) return;
    setGenerating(true);
    try {
      const result = await callTool('plan_storyboard_video', {
        project_slug: projectSlug,
        source_image_asset_id: sourceImageIds[0],
        source_image_asset_ids: sourceImageIds,
        storyboard_brief: storyboardBrief,
        loop_video: loopVideo,
        video_model: TOOL_BY_VIDEO_MODEL[selectedVideoModel],
        duration_s: durationS,
        rebuild_prompts: true,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Plan creation failed';
        toast({ title: 'Plan creation failed', description: msg, duration: 5000 });
        return;
      }
      await callTool('sync', { project_slug: projectSlug });
      toast({ title: 'Storyboard plan ready', description: 'Generate the storyboard and video in /plan.', duration: 2500 });
      onGenerated();
    } finally {
      setGenerating(false);
    }
  }, [sourceImageIds, generating, projectSlug, storyboardBrief, loopVideo, selectedVideoModel, durationS, callTool, onGenerated]);

  return (
    <div className="space-y-4">
      <UseTemplateCTA
        generating={generating}
        canGenerate={canGenerate}
        onUse={() => { void handleGenerate(); }}
        icon={<Images className="w-4 h-4" />}
        hint="Needs a source image — open Customize"
      />
      <CustomizeInputs>
        <div className="space-y-5">
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
            onBriefChange={setStoryboardBrief}
            onLoopChange={setLoopVideo}
          />
          <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono">
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
            <label className="flex items-center gap-1.5">
              <span className="text-emerald-300/50 uppercase tracking-wider">Model:</span>
              <select
                value={selectedVideoModel}
                onChange={(e) => setSelectedVideoModel(e.target.value as VideoModel)}
                className="h-6 px-1.5 rounded bg-black/60 border border-zinc-700 text-emerald-300/90 focus:outline-none focus:border-emerald-500/60"
              >
                {STORYBOARD_VIDEO_MODELS.map((m) => <option key={m} value={m}>{LABEL_BY_VIDEO_MODEL[m]}</option>)}
              </select>
            </label>
            <span className="text-emerald-300/45">16:9 / 2K storyboard / 720p video</span>
          </div>
        </div>
      </CustomizeInputs>
    </div>
  );
}

export function ClipShowSetup({ projectSlug, mediaItems, callTool, onGenerated }: PlanTemplateSetupProps) {
  const { loading, sidecar } = useCurrentSidecar(projectSlug, callTool);
  if (loading) return <SetupLoading />;
  return (
    <ClipShowSetupInner
      projectSlug={projectSlug}
      mediaItems={mediaItems}
      callTool={callTool}
      onGenerated={onGenerated}
      initial={isClipShowPlan(sidecar) ? sidecar : null}
    />
  );
}

// Collect a plan's distinct source-pool images (in order) to re-seed the editor.
function segmentsToPool(segments: ClipShowSegment[]): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const s of segments) {
    for (const id of s.source_image_asset_ids ?? []) {
      if (id && !seen.has(id)) { seen.add(id); pool.push(id); }
    }
  }
  return pool;
}

function ClipShowSetupInner({ projectSlug, mediaItems, callTool, onGenerated, initial }: PlanTemplateSetupProps & { initial: ClipShowPlanSidecar | null }) {
  // Seed from the existing plan, else auto-pick the newest voiced host + images
  // so "Use Template" works without opening Customize.
  const autoPick = initial ? null : autoPickClipShow(mediaItems);
  const [characterId, setCharacterId] = useState(initial?.character.asset_id ?? autoPick?.characterId ?? '');
  const [imageAssetIds, setImageAssetIds] = useState<string[]>(
    initial && !isStaleClipShowPlan(initial) ? segmentsToPool(initial.segments) : autoPick?.imageAssetIds ?? [],
  );
  const [generating, setGenerating] = useState(false);
  const cancelledRef = useRef(false);
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);

  const characterItem = useMemo(() => (characterId ? mediaItems.find((m) => m.id === characterId) ?? null : null), [characterId, mediaItems]);

  const handleCharacterDrop = useCallback((assetId: string) => {
    if (!assetId.startsWith('char-')) {
      toast({ title: 'Wrong asset type', description: `Drop a char-* host, got ${assetId}.`, duration: 3000 });
      return;
    }
    setCharacterId(assetId);
  }, []);

  // Clip Show narration needs a voiced host. hasVoice === false means we know
  // it lacks one; null/undefined (unknown) doesn't block — the server pre-check
  // is the backstop.
  const hostMissingVoice = characterItem?.hasVoice === false;
  const canGenerate = characterId.length > 0 && imageAssetIds.length > 0 && !hostMissingVoice && !generating;
  const ctaHint = hostMissingVoice
    ? `@${characterId} has no ElevenLabs voice — assign one or pick another in Customize`
    : 'Needs a host character + at least one image — open Customize';

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    const prevKey = clipShowSidecarKey(initial);
    setGenerating(true);
    try {
      const result = await callTool('plan_clip_show', {
        project_slug: projectSlug,
        character_asset_id: characterId,
        image_asset_ids: imageAssetIds,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'Clip Show plan failed';
        toast({ title: 'Clip Show failed', description: msg, duration: 5000 });
        return;
      }
      // plan_clip_show runs in the background (GPT-5.5). The model groups the pool
      // into jokes, so the joke count isn't known up front — poll read_plan until
      // a fresh clip_show plan for this host (changed key vs the previous) lands.
      const POLL_MS = 3000;
      const MAX_ATTEMPTS = 100; // ~5 min
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (cancelledRef.current) return;
        const planResult = await callTool('read_plan', { project_slug: projectSlug });
        if (planResult.isError) continue;
        let parsed: AnyPlanSidecar;
        try {
          const text = (planResult.content as Array<{ type: string; text: string }>)[0].text;
          parsed = JSON.parse(text);
        } catch { continue; }
        if (planFormula(parsed) !== 'clip_show') continue;
        const cs = parsed as ClipShowPlanSidecar;
        const matches = cs.character.asset_id === characterId && !isStaleClipShowPlan(cs) && cs.segments.length >= 1;
        if (matches && clipShowSidecarKey(cs) !== prevKey) {
          await callTool('sync', { project_slug: projectSlug });
          toast({ title: 'Clip Show planned', description: `${cs.segments.length} joke${cs.segments.length === 1 ? '' : 's'}`, duration: 2500 });
          onGenerated();
          return;
        }
      }
      toast({ title: 'Clip Show still generating', description: 'Open /plan — it will appear when ready.', duration: 4000 });
      onGenerated();
    } finally {
      if (!cancelledRef.current) setGenerating(false);
    }
  }, [canGenerate, initial, callTool, projectSlug, characterId, imageAssetIds, onGenerated]);

  return (
    <div className="space-y-4">
      <UseTemplateCTA
        generating={generating}
        canGenerate={canGenerate}
        onUse={() => { void handleGenerate(); }}
        icon={<Mic className="w-4 h-4" />}
        hint={ctaHint}
      />
      <CustomizeInputs>
        <div className="grid grid-cols-1 xl:grid-cols-[14rem_minmax(0,1fr)] gap-3">
          <ClipShowCharacterDropZone item={characterItem} assetId={characterId || null} onDropAsset={handleCharacterDrop} />
          <ClipShowItemsEditor imageAssetIds={imageAssetIds} mediaItems={mediaItems} onChange={setImageAssetIds} />
        </div>
      </CustomizeInputs>
    </div>
  );
}

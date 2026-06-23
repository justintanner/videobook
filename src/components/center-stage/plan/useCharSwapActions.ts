// Canvas-level orchestration for char_swap gens — the tool-call logic lifted
// from PlanViewer's SceneBlock, parameterized by scene index so one hook drives
// every node. Arg shapes mirror SceneBlock exactly (the server in
// swap-plan-scene-frame.ts / the seedance+grok jobs depends on them).
//
// All gens go through existing MCP tools that enqueue server-side jobs; nothing
// long-running runs here. The two propagation effects (extract_last_frame →
// seed next scene's first frame) are the one sanctioned tool-call-in-effect —
// idempotent and guarded per asset id, lifted verbatim from SceneBlock.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import { toast } from '@/hooks/useToast';
import {
  LABEL_BY_VIDEO_MODEL,
  PLAN_ASSET_ID,
  SHORT_LABEL_BY_MODEL,
  TOOL_BY_VIDEO_MODEL,
  buildGrokImagineToolArgs,
  buildSeedanceToolArgs,
  frameCharacterIds,
  variantKey,
  type PlanSidecar,
  type SwapModel,
  type SwapProvider,
  type VideoModel,
} from './charSwapModel';

export interface RunSwapOpts {
  priorSwapAssetId?: string;
  safeMode?: boolean;
  customPrompt?: string;
}

export interface CharSwapActions {
  runSwap: (
    sceneIndex: number,
    frameIndex: 1 | 2,
    provider: SwapProvider,
    model: SwapModel,
    opts?: RunSwapOpts,
  ) => Promise<{ newAssetId: string } | null>;
  runVideo: (sceneIndex: number, videoModel: VideoModel, prompt: string) => Promise<void>;
  runVideoReplace: (sceneIndex: number, assetId: string) => Promise<void>;
  promoteVariant: (sceneIndex: number, frameIndex: 1 | 2, assetId: string) => Promise<void>;
  // Persist the per-frame character wiring (the canvas connect/disconnect edits).
  setFrameCharacters: (sceneIndex: number, frameIndex: 1 | 2, characterAssetIds: string[]) => Promise<void>;
  // Kick off the vision auto-match job (all scenes when sceneIndex omitted).
  matchCharacters: (sceneIndex?: number) => Promise<{ jobId: string } | null>;
  isSwapInFlight: (sceneIndex: number, frameIndex: 1 | 2) => boolean;
  isVideoInFlight: (sceneIndex: number) => boolean;
}

function readText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string | null {
  try {
    return (result.content as Array<{ type: string; text: string }>)[0].text;
  } catch {
    return null;
  }
}

function errText(result: Awaited<ReturnType<UseMcpResult['callTool']>>, fallback: string): string {
  return (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? fallback;
}

export function useCharSwapActions(params: {
  sidecar: PlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
  sourceAspect: SourceAspect;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}): CharSwapActions {
  const { sidecar, mediaItems, projectSlug, sourceAspect, callTool, onSidecarUpdate } = params;

  // In-flight tags `${sceneIndex}:${frameIndex}:${variantKey}` and scene-index
  // set for video submits — drive per-node spinners before the asset appears.
  const [swapTags, setSwapTags] = useState<Set<string>>(new Set());
  const [videoScenes, setVideoScenes] = useState<Set<number>>(new Set());

  const applySidecar = useCallback((result: Awaited<ReturnType<UseMcpResult['callTool']>>) => {
    const text = readText(result);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { sidecar?: PlanSidecar };
      if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
    } catch {
      // Sidecar refreshes on the next read_plan.
    }
  }, [onSidecarUpdate]);

  const runSwap = useCallback<CharSwapActions['runSwap']>(async (sceneIndex, frameIndex, provider, model, opts) => {
    const tag = `${sceneIndex}:${frameIndex}:${variantKey(provider, model)}`;
    setSwapTags((prev) => new Set(prev).add(tag));
    try {
      const charIds = frameCharacterIds(sidecar.scenes[sceneIndex], frameIndex, sidecar.characters);
      const result = await callTool('swap_plan_scene_frame', {
        project_slug: projectSlug,
        scene_index: sceneIndex,
        frame_index: frameIndex,
        character_asset_ids: charIds.map((id) => `@${id}`),
        provider,
        model,
        ...(opts?.priorSwapAssetId ? { prior_swap_asset_id: opts.priorSwapAssetId } : {}),
        ...(opts?.safeMode ? { safe_mode: true } : {}),
        ...(opts?.customPrompt && opts.customPrompt.trim().length > 0 ? { custom_prompt: opts.customPrompt.trim() } : {}),
      });
      if (result.isError) {
        const code = provider === 'fal' ? `${SHORT_LABEL_BY_MODEL[model]}-fal` : SHORT_LABEL_BY_MODEL[model];
        toast({ title: `Scene ${sceneIndex + 1} ${code} image${frameIndex} swap failed`, description: errText(result, 'Swap failed'), duration: 5000 });
        return null;
      }
      const text = readText(result);
      if (text) {
        try {
          const parsed = JSON.parse(text) as { sidecar?: PlanSidecar; asset_id?: string };
          if (parsed.sidecar) onSidecarUpdate(parsed.sidecar);
          if (typeof parsed.asset_id === 'string') return { newAssetId: parsed.asset_id };
        } catch {
          // Job enqueued regardless; sidecar refreshes on next read_plan.
        }
      }
      return null;
    } finally {
      setSwapTags((prev) => {
        const next = new Set(prev);
        next.delete(tag);
        return next;
      });
    }
  }, [callTool, projectSlug, sidecar, onSidecarUpdate]);

  const runVideo = useCallback<CharSwapActions['runVideo']>(async (sceneIndex, videoModel, prompt) => {
    const scene = sidecar.scenes[sceneIndex];
    if (!scene) return;
    if (videoScenes.has(sceneIndex)) return;
    if (!scene.clip_filename || !scene.audio_filename) {
      toast({ title: `Scene ${sceneIndex + 1} not ready`, description: 'Source clip + audio still extracting — try again in a moment.', duration: 4000 });
      return;
    }
    const clipSlug = `${PLAN_ASSET_ID}/${scene.clip_filename}`;
    const audioSlug = `${PLAN_ASSET_ID}/${scene.audio_filename}`;
    const isGrok = videoModel === 'grok-imagine-1-5';
    const toolArgs = isGrok
      ? buildGrokImagineToolArgs(scene, sidecar.characters, audioSlug, prompt, sourceAspect)
      : buildSeedanceToolArgs(scene, sidecar.characters, mediaItems, clipSlug, audioSlug, prompt, sourceAspect);
    if (!toolArgs) {
      toast({ title: `Scene ${sceneIndex + 1}`, description: 'Generate the first-frame swap before running Grok Imagine.', duration: 4000 });
      return;
    }
    setVideoScenes((prev) => new Set(prev).add(sceneIndex));
    try {
      const result = await callTool(TOOL_BY_VIDEO_MODEL[videoModel], { project_slug: projectSlug, ...toolArgs });
      if (result.isError) {
        toast({ title: `Scene ${sceneIndex + 1} failed`, description: errText(result, `Failed to enqueue ${LABEL_BY_VIDEO_MODEL[videoModel]}`), duration: 5000 });
        return;
      }
      let newVidAssetId: string | null = null;
      const text = readText(result);
      if (text) {
        try {
          const parsed = JSON.parse(text) as { vid_asset_id?: string };
          if (typeof parsed.vid_asset_id === 'string') newVidAssetId = parsed.vid_asset_id;
        } catch {
          // Falls back to toast-only; tool always returns vid_asset_id.
        }
      }
      if (newVidAssetId) {
        const persist = await callTool('replace_plan_scene_video_swap', {
          project_slug: projectSlug,
          scene_index: sceneIndex,
          asset_id: newVidAssetId,
        });
        if (!persist.isError) applySidecar(persist);
      }
      toast({ title: `Scene ${sceneIndex + 1} enqueued`, description: `${LABEL_BY_VIDEO_MODEL[videoModel]} (kie) · 720p`, duration: 2500 });
    } finally {
      setVideoScenes((prev) => {
        const next = new Set(prev);
        next.delete(sceneIndex);
        return next;
      });
    }
  }, [callTool, projectSlug, sidecar, mediaItems, sourceAspect, videoScenes, applySidecar]);

  const runVideoReplace = useCallback<CharSwapActions['runVideoReplace']>(async (sceneIndex, assetId) => {
    const result = await callTool('replace_plan_scene_video_swap', {
      project_slug: projectSlug,
      scene_index: sceneIndex,
      asset_id: assetId,
    });
    if (result.isError) {
      toast({ title: `Scene ${sceneIndex + 1} video replace failed`, description: errText(result, 'Replace failed'), duration: 5000 });
      return;
    }
    applySidecar(result);
  }, [callTool, projectSlug, applySidecar]);

  const promoteVariant = useCallback<CharSwapActions['promoteVariant']>(async (sceneIndex, frameIndex, assetId) => {
    const result = await callTool('replace_plan_scene_frame_swap', {
      project_slug: projectSlug,
      scene_index: sceneIndex,
      frame_index: frameIndex,
      asset_id: assetId,
    });
    if (result.isError) {
      toast({ title: `Scene ${sceneIndex + 1} image${frameIndex} select failed`, description: errText(result, 'Replace failed'), duration: 5000 });
      return;
    }
    applySidecar(result);
  }, [callTool, projectSlug, applySidecar]);

  const setFrameCharacters = useCallback<CharSwapActions['setFrameCharacters']>(async (sceneIndex, frameIndex, characterAssetIds) => {
    const ids = characterAssetIds.map((id) => id.replace(/^@/, ''));
    if (ids.length < 1) return;
    const result = await callTool('set_plan_scene_frame_characters', {
      project_slug: projectSlug,
      scene_index: sceneIndex,
      frame_index: frameIndex,
      character_asset_ids: ids,
    });
    if (result.isError) {
      toast({ title: `Scene ${sceneIndex + 1} image${frameIndex} wiring failed`, description: errText(result, 'set_plan_scene_frame_characters failed'), duration: 5000 });
      return;
    }
    applySidecar(result);
  }, [callTool, projectSlug, applySidecar]);

  const matchCharacters = useCallback<CharSwapActions['matchCharacters']>(async (sceneIndex) => {
    const result = await callTool('match_plan_scene_characters', {
      project_slug: projectSlug,
      ...(sceneIndex != null ? { scene_index: sceneIndex } : {}),
    });
    if (result.isError) {
      toast({ title: 'Auto-match failed', description: errText(result, 'match_plan_scene_characters failed'), duration: 5000 });
      return null;
    }
    const text = readText(result);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as { job_id?: string };
      return typeof parsed.job_id === 'string' ? { jobId: parsed.job_id } : null;
    } catch {
      return null;
    }
  }, [callTool, projectSlug]);

  const isSwapInFlight = useCallback((sceneIndex: number, frameIndex: 1 | 2) => {
    const prefix = `${sceneIndex}:${frameIndex}:`;
    for (const t of swapTags) if (t.startsWith(prefix)) return true;
    return false;
  }, [swapTags]);

  const isVideoInFlight = useCallback((sceneIndex: number) => videoScenes.has(sceneIndex), [videoScenes]);

  // --- Last-frame propagation (sanctioned tool-call-in-effect) ---
  // When a scene's video reaches 'ready', extract its last frame and seed the
  // next scene's first frame. One-shot per video asset id.
  const propagatedRef = useRef<Set<string>>(new Set());
  const [pendingProps, setPendingProps] = useState<Array<{ imgAssetId: string; targetSceneIndex: number }>>([]);

  useEffect(() => {
    sidecar.scenes.forEach((scene, index) => {
      const vidId = scene.swap?.video;
      if (!vidId) return;
      if (index + 1 >= sidecar.scenes.length) return;
      if (propagatedRef.current.has(vidId)) return;
      const item = mediaItems.find((m) => m.id === vidId);
      if (!item || item.status !== 'ready') return;
      propagatedRef.current.add(vidId);
      void (async () => {
        const extract = await callTool('extract_last_frame', { project_slug: projectSlug, asset_id: vidId });
        if (extract.isError) {
          toast({ title: `Scene ${index + 1} last-frame extract failed`, description: errText(extract, 'extract_last_frame failed'), duration: 5000 });
          return;
        }
        const text = readText(extract);
        if (!text) return;
        try {
          const parsed = JSON.parse(text) as { image_asset_id?: string };
          if (typeof parsed.image_asset_id === 'string') {
            setPendingProps((prev) => [...prev, { imgAssetId: parsed.image_asset_id as string, targetSceneIndex: index + 1 }]);
          }
        } catch {
          // Skip; a regen retries.
        }
      })();
    });
  }, [sidecar, mediaItems, callTool, projectSlug]);

  useEffect(() => {
    if (pendingProps.length === 0) return;
    for (const pp of pendingProps) {
      const item = mediaItems.find((m) => m.id === pp.imgAssetId);
      if (!item) continue;
      if (item.status === 'error') {
        toast({ title: `Scene ${pp.targetSceneIndex + 1} last-frame extract errored`, description: item.failedMessage ?? 'extract failed', duration: 5000 });
        setPendingProps((prev) => prev.filter((x) => x !== pp));
        continue;
      }
      if (item.status !== 'ready') continue;
      setPendingProps((prev) => prev.filter((x) => x !== pp));
      void (async () => {
        const result = await callTool('replace_plan_scene_frame_swap', {
          project_slug: projectSlug,
          scene_index: pp.targetSceneIndex,
          frame_index: 1,
          asset_id: pp.imgAssetId,
        });
        if (result.isError) {
          toast({ title: `Scene ${pp.targetSceneIndex + 1} first-frame seed failed`, description: errText(result, 'replace_plan_scene_frame_swap failed'), duration: 5000 });
          return;
        }
        applySidecar(result);
        toast({ title: `Scene ${pp.targetSceneIndex + 1} first frame seeded`, description: `from ${pp.imgAssetId}`, duration: 2500 });
      })();
    }
  }, [pendingProps, mediaItems, callTool, projectSlug, applySidecar]);

  return { runSwap, runVideo, runVideoReplace, promoteVariant, setFrameCharacters, matchCharacters, isSwapInFlight, isVideoInFlight };
}

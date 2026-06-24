// Pure model layer for the char_swap plan formula — types, constants, and
// side-effect-free helpers shared by PlanViewer and the embedded PlanFlowStack
// editor. No JSX / React imports beyond types so this stays a plain module (and
// keeps react-refresh happy in the .tsx consumers).
//
// Extracted verbatim from PlanViewer.tsx — keep behaviour identical. Tool arg
// shapes here are the canonical source for both views; the server mirrors them
// in swap-plan-scene-frame.ts and the seedance/grok job payloads.
import type { MediaItem } from '@/components/sidebar/types';
import {
  falWanImageSizeForDimensions,
  kieImageAspectRatioForDimensions,
  seedanceAspectRatioForDimensions,
  type SourceAspect,
} from '@/lib/plan-aspect';

export interface PlanScene {
  start: number;
  end: number;
  visual: string;
  // Per-scene spoken dialog, sliced from the transcript at /plan-vis time. Seeds
  // the Grok Imagine video prompt; older plans lack it (guarded with `?? ''`).
  dialog?: string;
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
  // Per-frame character wiring set on the flow canvas (or by vision auto-match).
  // image{N} = ordered character asset_ids fed into that frame's swap (first =
  // Image 2, second = Image 3). Absent → consumers fall back to ALL characters
  // (legacy "both on-screen subjects" default).
  frame_characters?: {
    image1?: string[];
    image2?: string[];
  } | null;
  // When set, the last-frame (frame 2) swap drops the first-frame swap it would
  // otherwise thread as a continuity reference (the canvas "delete prior-frame
  // input" action). Only meaningful for frame 2 — frame 1 has no in-scene prior.
  skip_prior_swap?: boolean;
  // Per-frame "skip the character swap, use the original source frame as-is" flag
  // (the canvas "skip → source" action on the swap tile). When image{N} is true,
  // the video gen uses @plan/s{N}-image{F}-source.jpg as that keyframe and the
  // RUN VIDEO gate treats the frame as ready. Mutually exclusive with a selected
  // swap for the same frame — the server nulls one when the other is set.
  frame_source?: {
    image1?: boolean;
    image2?: boolean;
  } | null;
  swap?: {
    image1: string | null;
    image2: string | null;
    image1_variants?: Record<string, string>;
    image2_variants?: Record<string, string>;
    video?: string | null;
  } | null;
}

export interface PlanSidecar {
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
  generation_status?: 'draft' | 'generating' | 'ready' | 'failed';
  generation_error?: string;
  failed_at?: string;
  // Draft marker: the plan was prepared (skeleton written) but the vision job
  // has NOT been enqueued yet, so the user can read the analysis prompt before
  // generating. The work area shows a "Generate plan" button instead of polling;
  // it's cleared (and the job enqueued) on the explicit Generate.
  awaiting_start?: boolean;
}

// The character asset_ids wired to a frame's swap, in order. Falls back to ALL
// characters (legacy "both subjects" default) when no explicit wiring exists.
// Stale ids (not in the current roster) are dropped; an empty result also falls
// back to all, so a frame never ends up with zero references.
export function frameCharacterIds(
  scene: PlanScene | undefined,
  frameIndex: 1 | 2,
  allCharacters: PlanSidecar['characters'],
): string[] {
  const allIds = allCharacters.map((c) => c.asset_id);
  const wired = scene?.frame_characters?.[`image${frameIndex}` as 'image1' | 'image2'];
  if (wired && wired.length > 0) {
    const known = new Set(allIds);
    const filtered = wired.filter((id) => known.has(id));
    if (filtered.length > 0) return filtered;
  }
  return allIds;
}

// The character records (not just ids) wired to a frame's swap, in order.
export function frameCharacters(
  scene: PlanScene | undefined,
  frameIndex: 1 | 2,
  allCharacters: PlanSidecar['characters'],
): PlanSidecar['characters'] {
  const byId = new Map(allCharacters.map((c) => [c.asset_id, c]));
  return frameCharacterIds(scene, frameIndex, allCharacters)
    .map((id) => byId.get(id))
    .filter((c): c is PlanSidecar['characters'][number] => Boolean(c));
}

// True when a frame is set to skip its swap and use the original source frame.
export function frameUsesSource(scene: PlanScene | undefined, frameIndex: 1 | 2): boolean {
  return Boolean(scene?.frame_source?.[`image${frameIndex}` as 'image1' | 'image2']);
}

// The @plan slug for a scene's extracted source frame — the keyframe used when a
// frame skips its swap. Mirrors the server's sourceFilename in
// swap-plan-scene-frame.ts (1-based scene number).
export function sourceFrameSlug(sceneIndex: number, frameIndex: 1 | 2): string {
  return `@${PLAN_ASSET_ID}/s${sceneIndex + 1}-image${frameIndex}-source.jpg`;
}

// Count-aware default swap prompt. Mirrors the server's buildSwapPrompt
// (non-safe path) in swap-plan-scene-frame.ts so the JSON preview and the
// prompt actually sent stay identical. With one wired character the prior
// frame is Image 3; with two it is Image 4.
export function defaultSwapPrompt(charCount: number, hasPriorSwap: boolean): string {
  const single = charCount <= 1;
  const priorImg = single ? 'Image 3' : 'Image 4';
  const replace = single
    ? 'replace the person with the person from Image 2'
    : 'replace the people with the people from Image 2 and Image 3';
  const subjectsAfter = single ? 'that same person' : 'those same two people';
  const poses = single ? 'pose' : 'poses';
  if (hasPriorSwap) {
    return `Edit Image 1: ${replace}, matching each reference's appearance and outfit. ${priorImg} shows how ${subjectsAfter} appeared in the prior frame of this scene — match their look (face, hair, wardrobe, color grade) to ${priorImg} exactly so the two frames feel continuous. Keep Image 1's composition, framing, lighting, camera angle, and the original ${poses} unchanged.`;
  }
  return `Edit Image 1: ${replace}, matching each reference's appearance and outfit. Keep Image 1's composition, framing, lighting, camera angle, and the original ${poses} unchanged.`;
}

export function formatTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export type SwapModel = 'nano-banana-pro' | 'gpt-image-2' | 'wan-2-7-image-pro';
export type SwapProvider = 'kie' | 'fal';

export const ALL_SWAP_MODELS: SwapModel[] = ['nano-banana-pro', 'gpt-image-2', 'wan-2-7-image-pro'];
export const ALL_SWAP_PROVIDERS: SwapProvider[] = ['kie', 'fal'];

// Mirror of server SUPPORTED_MODELS_BY_PROVIDER: fal doesn't host gpt-image-2.
export const MODELS_BY_PROVIDER: Record<SwapProvider, SwapModel[]> = {
  kie: ['nano-banana-pro', 'gpt-image-2', 'wan-2-7-image-pro'],
  fal: ['nano-banana-pro', 'wan-2-7-image-pro'],
};

export const SHORT_LABEL_BY_MODEL: Record<SwapModel, string> = {
  'nano-banana-pro': 'nbp',
  'gpt-image-2': 'gi2',
  'wan-2-7-image-pro': 'wan',
};

// Variant key used in scene.swap.image{N}_variants. Bare model name = kie
// (preserves backward compat with older plans). `fal:{model}` = fal variant.
export function variantKey(provider: SwapProvider, model: SwapModel): string {
  return provider === 'fal' ? `fal:${model}` : model;
}

export function parseVariantKey(key: string): { provider: SwapProvider; model: SwapModel } | null {
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

export type VideoModel = 'seedance-2-ref' | 'seedance-2-fast' | 'seedance-2-mini';

// char_swap per-scene video picker. Seedance 2 Mini leads (the default) with
// Seedance Fast as the lighter alternative; the heavyweight Seedance 2 (ref)
// and Grok Imagine were dropped from this flow.
export const ALL_VIDEO_MODELS: VideoModel[] = ['seedance-2-mini', 'seedance-2-fast'];
// Storyboard formula keeps the priced Seedance 2 (ref) + Fast pair — Mini is a
// char_swap-only default for now.
export const STORYBOARD_VIDEO_MODELS: VideoModel[] = ['seedance-2-ref', 'seedance-2-fast'];

export const TOOL_BY_VIDEO_MODEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'generate_seedance2_video',
  'seedance-2-fast': 'generate_seedance2_fast_video',
  'seedance-2-mini': 'generate_seedance2_mini_video',
};

export const LABEL_BY_VIDEO_MODEL: Record<VideoModel, string> = {
  'seedance-2-ref': 'Seedance 2',
  'seedance-2-fast': 'Seedance Fast',
  'seedance-2-mini': 'Seedance 2 Mini',
};

// Per-scene clip + audio live as sibling files inside the `plan` asset
// (stamped into `.plan.json` by /plan-vis as `clip_filename` / `audio_filename`,
// e.g. "s1.mp4" / "s1.mp3"). The render path addresses them via the
// `@plan/<filename>` slug form the seedance/kie resolvers learned.
export const PLAN_ASSET_ID = 'plan';

export type FrameTileState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

export function deriveTileState(
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
export function modelCodeFromSwapAssetId(assetId: string | null | undefined): string | null {
  if (!assetId) return null;
  const m = /^img-((?:nbp|gi2|wan)(?:-fal)?)-s\d+-\d+(?:-\d+)*$/.exec(assetId);
  return m ? m[1] : null;
}

export type VideoTileState =
  | { kind: 'idle' }
  | { kind: 'generating'; label?: string }
  | { kind: 'ready'; src: string }
  | { kind: 'error'; message: string };

export function deriveVideoTileState(
  scene: PlanScene,
  mediaItems: MediaItem[],
  projectSlug: string,
  // True only while a video submit is actively in flight (the RUN VIDEO call
  // hasn't returned). Lets a not-yet-listed asset read as "generating" during
  // that window without spinning forever once the window closes.
  submitting = false,
): VideoTileState {
  const vidId = scene.swap?.video;
  if (!vidId) return { kind: 'idle' };
  const item = mediaItems.find((m) => m.id === vidId);
  if (!item) {
    // The linked video asset isn't in the asset list. While a submit is in
    // flight the asset already exists server-side but hasn't surfaced in
    // mediaItems yet → show the spinner. Otherwise the link is dangling: the
    // asset was deleted, or its creation was rolled back after a failed/timed-out
    // gen, so the scene points at an id that will never appear. Fall back to idle
    // (offer RUN VIDEO again — a fresh run overwrites the stale link) instead of
    // spinning forever.
    return submitting ? { kind: 'generating' } : { kind: 'idle' };
  }
  if (item.status === 'error') return { kind: 'error', message: item.failedMessage ?? 'video gen failed' };
  if (item.status === 'ready') {
    const src = `/files/${projectSlug}/${vidId}/original.mp4`;
    return { kind: 'ready', src };
  }
  // 'generating', 'replacing-audio', etc.
  const label = item.status === 'replacing-audio' ? 'splicing audio…' : 'generating…';
  return { kind: 'generating', label };
}

export const DEFAULT_PROMPT_BY_SWAP_MODEL: Record<SwapModel, string> = {
  'nano-banana-pro': "Photorealistic edit. Replace Image 1's people with Image 2 and Image 3 references, preserving each one's identity and clothing. Keep the original composition, framing, lighting, and camera angle exactly as in Image 1.",
  'gpt-image-2': "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.",
  'wan-2-7-image-pro': "Replace each person in Image 1 with the matching reference from Image 2 and Image 3. Match facial identity, hair, and outfit precisely. Preserve Image 1's pose, composition, lighting, and camera angle.",
};

// Frame 2 prompt — used when generating the last frame and a previously
// swapped first frame is available. Inputs are [source last frame, char A,
// char B, prior image1 swap]. Char refs drive identity; Image 4 is only a
// look-continuity reference (face/hair/wardrobe/color grade).
export const DEFAULT_PROMPT_FRAME2_PRIOR_SWAP = "Edit Image 1: replace the people with the people from Image 2 and Image 3, matching each reference's appearance and outfit. Image 4 shows how those same two people appeared in the prior frame of this scene — match their look (face, hair, wardrobe, color grade) to Image 4 exactly so the two frames feel continuous. Keep Image 1's composition, framing, lighting, camera angle, and the original poses unchanged.";

// Build a stable empty prompts map keyed by every (provider, model) combo.
// Frame 2 seeds with the prior-swap continuity prompt (mentions Image 4);
// frame 1 seeds with the per-model char-swap default.
export function makeEmptyModelPrompts(frameIndex: 1 | 2): Record<string, string> {
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

export function buildSwapPayload(
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rewriteVisualWithImageTokens(
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

// "Both keyframes present" gate. A frame is satisfied when its swap has landed
// and is ready, OR it's set to use the source frame as-is. Char-refs-only mode
// (neither frame swapped or sourced) is also fine; mixing one active frame with
// an empty other blocks RUN VIDEO.
export function videoReadyForGen(
  scene: PlanScene,
  tile1: FrameTileState,
  tile2: FrameTileState,
): { ok: boolean; reason?: string } {
  const frame1Active = !!scene.swap?.image1 || frameUsesSource(scene, 1);
  const frame2Active = !!scene.swap?.image2 || frameUsesSource(scene, 2);
  if (!frame1Active && !frame2Active) return { ok: true };
  const sat1 = frameUsesSource(scene, 1) || tile1.kind === 'ready';
  const sat2 = frameUsesSource(scene, 2) || tile2.kind === 'ready';
  if (sat1 && sat2) return { ok: true };
  return { ok: false, reason: 'Both frames must be ready (swap or skipped to source)' };
}

// Per-frame keyframe slug for the video gen: a ready swap asset (`@id`), or the
// source frame (`@plan/…`) when the frame is skipped to source. Null when the
// frame has no usable keyframe yet (no swap / still generating).
function frameKeyframeSlug(
  scene: PlanScene,
  frameIndex: 1 | 2,
  sceneIndex: number,
  mediaItems: MediaItem[],
): string | null {
  if (frameUsesSource(scene, frameIndex)) return sourceFrameSlug(sceneIndex, frameIndex);
  const id = scene.swap?.[`image${frameIndex}` as 'image1' | 'image2'];
  if (!id) return null;
  const item = mediaItems.find((m) => m.id === id);
  return item?.status === 'ready' ? `@${id}` : null;
}

// Both keyframe slugs when both frames resolve (ready swap or skipped to source);
// otherwise null so the caller falls back to bare character refs.
function readyKeyframeSlugs(
  scene: PlanScene,
  sceneIndex: number,
  mediaItems: MediaItem[],
): [string, string] | null {
  const a = frameKeyframeSlug(scene, 1, sceneIndex, mediaItems);
  const b = frameKeyframeSlug(scene, 2, sceneIndex, mediaItems);
  if (!a || !b) return null;
  return [a, b];
}

export const KIE_MODEL_NAME_BY_VIDEO: Record<VideoModel, string> = {
  'seedance-2-ref': 'bytedance/seedance-2',
  'seedance-2-fast': 'bytedance/seedance-2-fast',
  'seedance-2-mini': 'bytedance/seedance-2-mini',
};

export function buildKieVideoPayload(
  videoModel: VideoModel,
  scene: PlanScene,
  sceneIndex: number,
  characters: PlanSidecar['characters'],
  mediaItems: MediaItem[],
  sceneClipSlug: string | null,
  sceneAudioSlug: string | null,
  customPrompt: string,
  sourceAspect: SourceAspect,
): { model: string; input: Record<string, unknown> } {
  const keyframes = readyKeyframeSlugs(scene, sceneIndex, mediaItems);
  const referenceImages = keyframes ?? characters.map((c) => `@${c.asset_id}`);
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
export function buildSeedanceToolArgs(
  scene: PlanScene,
  sceneIndex: number,
  characters: PlanSidecar['characters'],
  mediaItems: MediaItem[],
  sceneClipSlug: string,
  sceneAudioSlug: string,
  customPrompt: string,
  sourceAspect: SourceAspect,
): Record<string, unknown> {
  const keyframes = readyKeyframeSlugs(scene, sceneIndex, mediaItems);
  const imageSlugs = keyframes ?? characters.map((c) => `@${c.asset_id}`);
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

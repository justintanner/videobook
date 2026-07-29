import type { Artifact, Engine } from "videobook-engine";
import type {
  BackgroundMode,
  FontSizePreset,
  Orientation,
  OsgPosition,
  OsgSize,
  SubtitlePosition,
  SubtitleStyle,
} from "./remotion/subtitles/types.js";
import { queue } from "./queue.js";
import { readTimeline } from "./timeline-helpers.js";
import { isLanguageSetting } from "./jobs/_translate-transcript.js";
import { findAutoRenderActions, readStoredRenderDefaults } from "./tools/sync.js";
import {
  DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
} from "./remotion/keyword-graphics.js";

type AssetWorkState = {
  status: string;
  meta?: {
    kind?: unknown;
    orientation?: unknown;
  } | null;
};

type LazyRenderResult = {
  jobId: string;
};

type LazyAnalysisResult = {
  jobId: string;
};

function isSubtitleStyle(value: unknown): value is SubtitleStyle {
  return value === "impact" || value === "highlight";
}

function isSubtitlePosition(value: unknown): value is SubtitlePosition {
  return value === "top" || value === "middle" || value === "bottom";
}

function isFontSizePreset(value: unknown): value is FontSizePreset {
  return value === "small" || value === "medium" || value === "large";
}

const OSG_POSITIONS: readonly OsgPosition[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

function isOsgPosition(value: unknown): value is OsgPosition {
  return OSG_POSITIONS.includes(value as OsgPosition);
}

function isOsgSize(value: unknown): value is OsgSize {
  return value === "small" || value === "medium" || value === "large";
}

function isBackgroundMode(value: unknown): value is BackgroundMode {
  return value === "blur" || value === "black";
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/**
 * Revive the slot-drop vision analysis for a timeline-assigned video whose
 * .original.analysis.json is missing — the state a force re-process (trim,
 * re-download) leaves behind after it invalidates the analysis sidecars.
 * assign_slot only fires on slot drop, so without this revival the auto
 * pipeline (analyze_video → ElevenLabs transcribe → lazy render) stays wedged
 * and render_timeline reports missing_renders until a manual /render.
 */
export async function enqueueLazyAnalysisIfSlotted(
  fs: Engine,
  bookId: string,
  assetId: string,
): Promise<LazyAnalysisResult | null> {
  if (!assetId.startsWith("vid-")) return null;
  // Same provider gate as assign_slot's lazy analysis: truthy env check (not
  // getApiKey) so placeholder keys used in tests pass; the real placeholder
  // defense lives at the API call inside analyze-video.
  if (!process.env.KIE_API_KEY) return null;

  const asset = fs.artifacts.get(assetId);
  if (!asset.ok) return null;
  const timeline = readTimeline(fs);
  if (!timeline.slots.some((slot) => slot.artifactId === asset.value.artifactId)) return null;

  const manifestResult = await fs.files.manifest(assetId);
  if (!manifestResult.ok) return null;
  const fileNames = new Set(manifestResult.value.files.map((f) => f.name));
  if (fileNames.has(".original.analysis.json")) return null;

  // Stable dedupe key: concurrent triggers collapse onto one queued job.
  const jobId = `auto-analyze-${assetId}`;
  await queue.enqueue(jobId, {
    type: "analyze_video",
    assetId,
    assetDir: manifestResult.value.path,
    bookId,
    hasTranscription: fileNames.has(".analysis.gpt4otrans.json"),
  });
  return { jobId };
}

async function isRenderAlreadyQueued(
  fs: Engine,
  assetId: string,
  orientation: Orientation,
): Promise<boolean> {
  const work = await fs.jobs.artifactWork.read(assetId);
  if (!work.ok || !work.value) return false;
  const state = work.value as AssetWorkState;
  return state.status !== "ready"
    && state.meta?.kind === "render"
    && state.meta.orientation === orientation;
}

export async function enqueueLazyTimelineRender(
  fs: Engine,
  bookId: string,
  assetId: string,
  knownAsset?: Artifact,
): Promise<LazyRenderResult | null> {
  if (!assetId.startsWith("vid-")) return null;

  const resolved = fs.artifacts.get(assetId);
  if (!resolved.ok) return null;
  const timeline = readTimeline(fs);
  if (!timeline.slots.some((slot) => slot.artifactId === resolved.value.artifactId)) return null;

  const orientation = timeline.render;
  if (await isRenderAlreadyQueued(fs, assetId, orientation)) return null;

  const asset =
    knownAsset ??
    fs.artifacts.list().find((entry) => entry.slug === assetId);
  if (!asset) return null;

  const renderActions = await findAutoRenderActions(fs, bookId, [asset], orientation);
  if (renderActions.length === 0) return null;

  const action = renderActions[0];
  const stored = await readStoredRenderDefaults(fs, assetId, bookId, orientation);
  const subtitlesEnabled = action.hasElevenlabs && stored.subtitlesEnabled === true;
  // Stable dedupe key: concurrent triggers (job-completion hooks racing a
  // sync poll) collapse onto one queued render instead of double-rendering.
  const jobId = `auto-render-${assetId}-${orientation}`;

  await queue.enqueue(jobId, {
    type: "render_project",
    bookId,
    assetId: action.assetId,
    orientation,
    assets: [{
      assetId: action.assetId,
      assetDir: action.assetDir,
      videoPath: action.videoPath,
      videoFilename: action.videoFilename,
    }],
    subtitlesEnabled,
    subtitleLanguage: isLanguageSetting(stored.subtitleLanguage) ? stored.subtitleLanguage : "original",
    highlightStyle: isSubtitleStyle(stored.highlightStyle) ? stored.highlightStyle : "highlight",
    position: isSubtitlePosition(stored.position) ? stored.position : "bottom",
    fontSize: isFontSizePreset(stored.fontSize) ? stored.fontSize : "medium",
    textColor: stringOr(stored.textColor, "#FFFFFF"),
    highlightColor: stringOr(stored.highlightColor, "#991B1B"),
    audioFadeIn: numberOr(stored.audioFadeIn, 0),
    audioFadeOut: numberOr(stored.audioFadeOut, 0),
    audioVolume: numberOr(stored.audioVolume, 100),
    osgImagePath: nullableString(stored.osgImagePath),
    osgAssetId: nullableString(stored.osgAssetId),
    osgPosition: isOsgPosition(stored.osgPosition) ? stored.osgPosition : "top-right",
    osgSize: isOsgSize(stored.osgSize) ? stored.osgSize : "medium",
    osgScale: numberOr(stored.osgScale, 1),
    osgStartSeconds: typeof stored.osgStartSeconds === "number" ? stored.osgStartSeconds : null,
    osgEndSeconds: typeof stored.osgEndSeconds === "number" ? stored.osgEndSeconds : null,
    osgTailSeconds: typeof stored.osgTailSeconds === "number" ? stored.osgTailSeconds : null,
    keywordGraphicsEnabled: stored.keywordGraphicsEnabled === true,
    keywordGraphicsMaxCount: numberOr(stored.keywordGraphicsMaxCount, DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT),
    keywordGraphicsLingerSeconds: numberOr(
      stored.keywordGraphicsLingerSeconds,
      DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
    ),
    keywordGraphicsKeywords: stringArrayOrNull(stored.keywordGraphicsKeywords),
    backgroundMode: isBackgroundMode(stored.backgroundMode) ? stored.backgroundMode : "blur",
    strokeWidth: numberOr(stored.strokeWidth, 6),
    strokeColor: stringOr(stored.strokeColor, "#000000"),
    shadowBlur: numberOr(stored.shadowBlur, 6),
    shadowOpacity: numberOr(stored.shadowOpacity, 60),
  } as unknown as Record<string, unknown>);

  return { jobId };
}

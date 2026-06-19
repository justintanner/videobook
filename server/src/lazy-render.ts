import type { AssetEntry, VideocityFs } from "videocity-engine";
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
import { isLanguageSetting } from "./jobs/_translate-transcript.js";
import { findAutoRenderActions, readStoredRenderDefaults } from "./tools/sync.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type TimelineAudioClip = {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

type ViewerSize = "landscape" | "portrait" | "square" | "original";

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

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

function normalizeConfig(raw: TimelineConfig | TimelineSlot[]): TimelineConfig {
  if (Array.isArray(raw)) return { slots: raw, render: "landscape" };
  const render = Array.isArray(raw.render)
    ? (raw.render as unknown as string[])[0]
    : raw.render;
  return {
    ...raw,
    render: isOrientation(render) ? render : "landscape",
  };
}

function isOrientation(value: unknown): value is Orientation {
  return value === "landscape" || value === "portrait" || value === "square";
}

function isSubtitleStyle(value: unknown): value is SubtitleStyle {
  return value === "impact" || value === "highlight";
}

function isSubtitlePosition(value: unknown): value is SubtitlePosition {
  return value === "top" || value === "middle" || value === "bottom";
}

function isFontSizePreset(value: unknown): value is FontSizePreset {
  return value === "small" || value === "medium" || value === "large";
}

function isOsgPosition(value: unknown): value is OsgPosition {
  return value === "top-left" || value === "top-right" || value === "bottom-left" || value === "bottom-right";
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

async function isRenderAlreadyQueued(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  orientation: Orientation,
): Promise<boolean> {
  const work = await fs.assetWork.read(projectSlug, assetId);
  if (!work.ok || !work.value) return false;
  const state = work.value as AssetWorkState;
  return state.status !== "ready"
    && state.meta?.kind === "render"
    && state.meta.orientation === orientation;
}

export async function enqueueLazyTimelineRender(
  fs: VideocityFs,
  projectSlug: string,
  assetId: string,
  knownAsset?: AssetEntry,
): Promise<LazyRenderResult | null> {
  if (!assetId.startsWith("vid-")) return null;

  const timelineResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", projectSlug);
  if (!timelineResult.ok) return null;

  const config = normalizeConfig(timelineResult.value);
  if (!config.slots.some((slot) => slot.slug === assetId)) return null;

  const orientation = config.render;
  if (await isRenderAlreadyQueued(fs, projectSlug, assetId, orientation)) return null;

  const asset = knownAsset ?? (await fs.listAssets(projectSlug)).find((entry) => entry.id === assetId);
  if (!asset) return null;

  const renderActions = await findAutoRenderActions(fs, projectSlug, [asset], orientation);
  if (renderActions.length === 0) return null;

  const action = renderActions[0];
  const stored = await readStoredRenderDefaults(fs, assetId, projectSlug, orientation);
  const subtitlesEnabled = action.hasElevenlabs && stored.subtitlesEnabled !== false;
  const jobId = `auto-render-${assetId}-${orientation}-${Date.now()}`;

  await queue.enqueue(jobId, {
    type: "render_project",
    projectSlug,
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
    audioFadeIn: numberOr(stored.audioFadeIn, 150),
    audioFadeOut: numberOr(stored.audioFadeOut, 100),
    audioVolume: numberOr(stored.audioVolume, 100),
    osgImagePath: nullableString(stored.osgImagePath),
    osgAssetId: nullableString(stored.osgAssetId),
    osgPosition: isOsgPosition(stored.osgPosition) ? stored.osgPosition : "top-right",
    osgSize: isOsgSize(stored.osgSize) ? stored.osgSize : "medium",
    backgroundMode: isBackgroundMode(stored.backgroundMode) ? stored.backgroundMode : "blur",
    strokeWidth: numberOr(stored.strokeWidth, 6),
    strokeColor: stringOr(stored.strokeColor, "#000000"),
    shadowBlur: numberOr(stored.shadowBlur, 6),
    shadowOpacity: numberOr(stored.shadowOpacity, 60),
  } as unknown as Record<string, unknown>);

  return { jobId };
}

export const LIGHTNING_SCENE_TOOL = "generate_kie_nano_banana_2_1_image";
export const LIGHTNING_SCENE_MODEL_KEY = "nano_banana_2_1";
export const LIGHTNING_SCENE_ASPECT_RATIO = "16:9";
export const LIGHTNING_SCENE_RESOLUTION = "2K";
export const LIGHTNING_SCENE_OUTPUT_FORMAT = "jpg";
export const LIGHTNING_SCENE_PROMPT_WORDS = 25;

export const LIGHTNING_VIDEO_TOOL = "generate_kie_seedance_2_5_video";
export const LIGHTNING_VIDEO_ASPECT_RATIO = "16:9";
export const LIGHTNING_VIDEO_RESOLUTION = "1080p";
export const LIGHTNING_VIDEO_DURATION = "13";
export const LIGHTNING_VIDEO_DURATION_SECONDS = 13;
export const LIGHTNING_VIDEO_OUTPUT_FORMAT = "mp4";
export const LIGHTNING_VIDEO_GENERATE_AUDIO = true;
export const LIGHTNING_VIDEO_PROMPT_WORDS = 60;

export const LIGHTNING_SEEDANCE_SCHEMA_DEFAULTS = {
  resolution: LIGHTNING_VIDEO_RESOLUTION,
  aspect_ratio: LIGHTNING_VIDEO_ASPECT_RATIO,
  duration: LIGHTNING_VIDEO_DURATION,
  output_format: LIGHTNING_VIDEO_OUTPUT_FORMAT,
  generate_audio: LIGHTNING_VIDEO_GENERATE_AUDIO,
} as const;

export const LIGHTNING_SCENE_SCHEMA_DEFAULTS = {
  aspect_ratio: LIGHTNING_SCENE_ASPECT_RATIO,
  resolution: LIGHTNING_SCENE_RESOLUTION,
  output_format: LIGHTNING_SCENE_OUTPUT_FORMAT,
} as const;

export const LIGHTNING_COLD_OPEN_SECONDS = 2.3;
export const LIGHTNING_HANDLE_SECONDS = 3;
export const LIGHTNING_QR_LEAD_SECONDS = 2.3;
export const LIGHTNING_FADE_SECONDS = 0.3;

export const LIGHTNING_POST_PLATFORM = "tiktok" as const;
export const LIGHTNING_POST_LANGUAGE = "th" as const;
export const LIGHTNING_POST_TAGS = ["fyp", "bkk"] as const;

export type WatermarkPlatformName = "tiktok" | "x";

export type LightningWatermarkProfile = {
  platform: WatermarkPlatformName;
  handle: string;
  profileUrl: string;
  includePlatformIcon: boolean;
  includeHandleBorder: boolean;
  handlePaddingX: number;
  handlePaddingY: number;
  handleRounding: number;
  scale: number;
  mode: "burn" | "overlay";
  handlePlacement: "center" | "above-qr" | "on-qr" | "below-qr";
  handleVerticalPercent: number;
  handleStartSeconds: number;
  handleEndSeconds: number | null;
  handleOpacity: number;
  qrPosition: "bottom-right" | "auto";
  qrLeadSeconds: number | null;
  qrOpacity: number;
  fadeSeconds: number;
};

export const LIGHTNING_WATERMARK_PROFILE: LightningWatermarkProfile = {
  platform: "tiktok",
  handle: "jtbkk",
  profileUrl: "https://www.tiktok.com/@jtbkk",
  includePlatformIcon: true,
  includeHandleBorder: true,
  handlePaddingX: 15,
  handlePaddingY: 12,
  handleRounding: 56,
  scale: 1,
  mode: "burn",
  handlePlacement: "center",
  handleVerticalPercent: 10,
  handleStartSeconds: 0,
  handleEndSeconds: LIGHTNING_HANDLE_SECONDS,
  handleOpacity: 0.28,
  qrPosition: "bottom-right",
  qrLeadSeconds: LIGHTNING_QR_LEAD_SECONDS,
  qrOpacity: 0.37,
  fadeSeconds: LIGHTNING_FADE_SECONDS,
};

export const X_WATERMARK_PROFILE: LightningWatermarkProfile = {
  platform: "x",
  handle: "justinwtanner",
  profileUrl: "",
  includePlatformIcon: true,
  includeHandleBorder: true,
  handlePaddingX: 32,
  handlePaddingY: 32,
  handleRounding: 100,
  scale: 1,
  mode: "burn",
  handlePlacement: "center",
  handleVerticalPercent: 33,
  handleStartSeconds: 0,
  handleEndSeconds: null,
  handleOpacity: 0.5,
  qrPosition: "auto",
  qrLeadSeconds: null,
  qrOpacity: 0.5,
  fadeSeconds: 0.5,
};

export type StoredWatermarkProfile = Partial<Omit<LightningWatermarkProfile, "platform">> & {
  qrStartSeconds?: number | null;
  qrEndSeconds?: number | null;
};

export function watermarkProfileToSave(
  base: LightningWatermarkProfile,
  appearance: StoredWatermarkProfile,
  timing: {
    explicit: boolean;
    qrStartSeconds?: number;
    qrEndSeconds?: number;
    handleStartSeconds?: number;
    handleEndSeconds?: number;
  },
): StoredWatermarkProfile {
  if (!timing.explicit) {
    return {
      ...appearance,
      handleStartSeconds: base.handleStartSeconds,
      handleEndSeconds: base.handleEndSeconds,
      qrLeadSeconds: base.qrLeadSeconds,
      qrStartSeconds: null,
      qrEndSeconds: null,
    };
  }
  return {
    ...appearance,
    handleStartSeconds: timing.handleStartSeconds ?? base.handleStartSeconds,
    handleEndSeconds: timing.handleEndSeconds ?? null,
    qrLeadSeconds: null,
    qrStartSeconds: timing.qrStartSeconds ?? null,
    qrEndSeconds: timing.qrEndSeconds ?? null,
  };
}

const PROFILE_KEYS = [
  "handle",
  "profileUrl",
  "includePlatformIcon",
  "includeHandleBorder",
  "handlePaddingX",
  "handlePaddingY",
  "handleRounding",
  "scale",
  "mode",
  "handlePlacement",
  "handleVerticalPercent",
  "handleStartSeconds",
  "handleEndSeconds",
  "handleOpacity",
  "qrPosition",
  "qrLeadSeconds",
  "qrOpacity",
  "fadeSeconds",
] as const satisfies readonly (keyof StoredWatermarkProfile)[];

function definedProfileFields(stored: StoredWatermarkProfile | null | undefined): StoredWatermarkProfile {
  if (!stored) return {};
  const next: StoredWatermarkProfile = {};
  for (const key of PROFILE_KEYS) {
    const value = stored[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

export function watermarkProfileFor(
  platform: WatermarkPlatformName,
  stored: StoredWatermarkProfile | null | undefined,
): LightningWatermarkProfile {
  const base = platform === "tiktok" ? LIGHTNING_WATERMARK_PROFILE : X_WATERMARK_PROFILE;
  return { ...base, ...definedProfileFields(stored), platform };
}

export function canonicalWatermarkProfile(profile: LightningWatermarkProfile): LightningWatermarkProfile {
  return watermarkProfileFor(profile.platform, profile);
}

export type WatermarkWindows = {
  handleStartSeconds: number;
  handleEndSeconds: number;
  qrStartSeconds: number;
  qrEndSeconds: number;
};

export function watermarkWindowsFor(
  profile: LightningWatermarkProfile,
  durationSeconds: number,
): WatermarkWindows {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const handleStart = Math.min(duration, Math.max(0, profile.handleStartSeconds));
  const handleEnd = profile.handleEndSeconds == null
    ? duration
    : Math.min(duration, Math.max(handleStart, profile.handleEndSeconds));
  const qrEnd = duration;
  const lead = profile.qrLeadSeconds;
  const qrStart = lead == null ? 0 : Math.max(0, duration - Math.min(duration, Math.max(0, lead)));
  return {
    handleStartSeconds: handleStart,
    handleEndSeconds: handleEnd,
    qrStartSeconds: qrStart,
    qrEndSeconds: qrEnd,
  };
}

export function suggestedColdOpen(durationSeconds: number): { startSeconds: number; endSeconds: number } {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const minimum = 0.5;
  const preferred = Math.min(duration, LIGHTNING_COLD_OPEN_SECONDS);
  const endSeconds = preferred >= minimum || duration < minimum ? preferred : Math.min(duration, minimum);
  return { startSeconds: 0, endSeconds };
}

function finiteSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

export function finishingIdentityKey(input: {
  sourceObjectHash: string;
  startSeconds: number;
  endSeconds: number;
  profile: LightningWatermarkProfile & { qrStartSeconds?: number | null; qrEndSeconds?: number | null };
  qrStartSeconds?: number | null;
  qrEndSeconds?: number | null;
}): string {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const qrStart = finiteSeconds(input.qrStartSeconds !== undefined ? input.qrStartSeconds : input.profile.qrStartSeconds);
  const qrEnd = finiteSeconds(input.qrEndSeconds !== undefined ? input.qrEndSeconds : input.profile.qrEndSeconds);
  return JSON.stringify({
    sourceObjectHash: input.sourceObjectHash,
    startSeconds: round(input.startSeconds),
    endSeconds: round(input.endSeconds),
    profile: canonicalWatermarkProfile(input.profile),
    ...(qrStart === null && qrEnd === null ? {} : { qrStartSeconds: qrStart, qrEndSeconds: qrEnd }),
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function preservedPrompt(value: string, maxWords: number, authored: boolean): string {
  const trimmed = value.trim();
  if (authored || maxWords < 1) return trimmed;
  const words = trimmed.split(/\s+/u).filter(Boolean);
  return words.length <= maxWords ? trimmed : words.slice(0, maxWords).join(" ");
}

export function submittedGenerationPrompt(input: {
  dispatchedPrompt?: unknown;
  cellPrompt?: unknown;
  resolvedPrompt?: unknown;
}): string {
  const dispatched = text(input.dispatchedPrompt);
  if (dispatched) return dispatched;
  return text(input.cellPrompt);
}

export function freshPostLanguage(
  platform: string,
  language: unknown,
): "en" | "th" {
  if (language === "en" || language === "th") return language;
  return platform === LIGHTNING_POST_PLATFORM ? LIGHTNING_POST_LANGUAGE : "en";
}

export function freshPostTags(platform: string, tags: readonly string[] | undefined): string[] | undefined {
  if (tags !== undefined) return [...tags];
  return platform === LIGHTNING_POST_PLATFORM ? [...LIGHTNING_POST_TAGS] : undefined;
}

export function payloadPrompt(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "";
  const input = payload.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const nested = text((input as Record<string, unknown>).prompt);
    if (nested) return nested;
  }
  return text(payload.prompt);
}

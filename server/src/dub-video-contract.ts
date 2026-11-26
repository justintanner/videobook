export type DubQuality = "speed" | "precision";

export const DUB_VIDEO_MAX_LANGUAGES = 5;

export const DUB_VIDEO_MODELS: Readonly<Record<DubQuality, string>> = {
  speed: "fal:fal-ai/heygen/v2/translate/speed",
  precision: "fal:fal-ai/heygen/v2/translate/precision",
};

export const DUB_VIDEO_RATES_USD_PER_SECOND: Readonly<Record<DubQuality, number>> = {
  speed: 0.05,
  precision: 0.1,
};

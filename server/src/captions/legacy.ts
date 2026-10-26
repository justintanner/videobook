import { z } from "zod";
import type { CaptionStyle } from "./model.js";
import { CAPTION_MOTIONS, CAPTION_PRESETS } from "./model.js";

export const LEGACY_ALIVE_SETTINGS_KEY = "alive-captions.settings";
export const LEGACY_ALIVE_ANALYSIS_KEY = "alive-captions.analysis";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

const legacyAliveSettingsSchema = z.object({
  style: z.enum(CAPTION_PRESETS),
  motion: z.enum(CAPTION_MOTIONS),
  energySizing: z.boolean(),
  snapToOnsets: z.boolean(),
  avoidFaces: z.boolean(),
  avoidText: z.boolean(),
  textColor: hex,
  hitColor: hex,
}).partial();

export function styleFromLegacyAliveSettings(value: unknown): Partial<CaptionStyle> {
  const parsed = legacyAliveSettingsSchema.safeParse(value);
  if (!parsed.success) return {};
  const settings = parsed.data;
  const style: Partial<CaptionStyle> = {};
  if (settings.style) style.preset = settings.style;
  if (settings.motion) style.motion = settings.motion;
  if (settings.energySizing !== undefined) style.energySizing = settings.energySizing;
  if (settings.snapToOnsets !== undefined) style.snapToOnsets = settings.snapToOnsets;
  if (settings.avoidFaces !== undefined) style.avoidFaces = settings.avoidFaces;
  if (settings.avoidText !== undefined) style.avoidText = settings.avoidText;
  if (settings.textColor) style.textColor = settings.textColor.toUpperCase();
  if (settings.hitColor) style.highlightColor = settings.hitColor.toUpperCase();
  return style;
}

const legacyRegionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const legacyWordSchema = z.object({
  text: z.string(),
  transcriptStart: z.number(),
  transcriptEnd: z.number(),
  onsetStart: z.number(),
  energy: z.number(),
});

const legacyAliveAnalysisSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  durationSeconds: z.number(),
  envelopeHz: z.number(),
  envelope: z.array(z.number()),
  onsets: z.array(z.number()),
  regionsAnalyzed: z.boolean(),
  phrases: z.array(z.object({
    id: z.string(),
    frameTime: z.number(),
    regions: z.array(legacyRegionSchema),
    lines: z.array(z.array(legacyWordSchema)),
  })),
});

export type LegacyAliveAnalysis = z.infer<typeof legacyAliveAnalysisSchema>;

export function parseLegacyAliveAnalysis(value: unknown): LegacyAliveAnalysis | null {
  const parsed = legacyAliveAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

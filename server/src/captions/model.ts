import { z } from "zod";

export const CAPTION_DOCUMENT_VERSION = 1;
export const CAPTION_ASPECTS = ["9:16", "1:1", "4:5", "16:9"] as const;
export const CAPTION_PRESETS = ["karaoke", "stack", "punch"] as const;
export const CAPTION_MOTIONS = ["pop", "slam", "rise"] as const;
export const CAPTION_BACKGROUNDS = ["blur", "black"] as const;
export const ORIGINAL_CAPTION_LANGUAGE = "original";

export type CaptionAspect = typeof CAPTION_ASPECTS[number];
export type CaptionPreset = typeof CAPTION_PRESETS[number];
export type CaptionMotion = typeof CAPTION_MOTIONS[number];

const MAX_CAPTION_WORDS = 20_000;
export const MAX_CAPTION_WORD_LENGTH = 80;
export const MIN_CAPTION_WORD_SECONDS = 0.04;
export const MAX_CAPTION_OFFSET_MS = 2_000;
export const CAPTION_FONT_SCALE_RANGE = { min: 0.6, max: 1.8 } as const;
export const CAPTION_OUTLINE_RANGE = { min: 0, max: 16 } as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u);
const seconds = z.number().finite().nonnegative();
const ratio = z.number().finite().min(0).max(1);
const aspectSchema = z.enum(CAPTION_ASPECTS);

export const captionPositionsSchema = z.object({
  "9:16": ratio.optional(),
  "1:1": ratio.optional(),
  "4:5": ratio.optional(),
  "16:9": ratio.optional(),
}).strict();

export type CaptionPositions = z.infer<typeof captionPositionsSchema>;

const analysedWordSchema = z.object({
  text: z.string(),
  start: seconds,
  end: seconds,
  onset: seconds,
  energy: ratio,
}).strict();

export const captionWordSchema = z.object({
  id: z.string().regex(/^w\d+$/u),
  text: z.string().max(MAX_CAPTION_WORD_LENGTH),
  start: seconds,
  end: seconds,
  analysed: analysedWordSchema.nullable(),
  textCorrected: z.boolean(),
  timingCorrected: z.boolean(),
  hidden: z.boolean(),
  speaker: z.string().max(64).nullable(),
}).strict();

export type CaptionWord = z.infer<typeof captionWordSchema>;

export const captionPhraseSchema = z.object({
  id: z.string().regex(/^p\d+$/u),
  wordIds: z.array(z.string()).min(1),
  positions: captionPositionsSchema,
}).strict();

export type CaptionPhrase = z.infer<typeof captionPhraseSchema>;

export const captionStyleSchema = z.object({
  preset: z.enum(CAPTION_PRESETS),
  motion: z.enum(CAPTION_MOTIONS),
  fontScale: z.number().finite().min(CAPTION_FONT_SCALE_RANGE.min).max(CAPTION_FONT_SCALE_RANGE.max),
  textColor: hexColor,
  highlightColor: hexColor,
  outlineColor: hexColor,
  outlineWidth: z.number().finite().min(CAPTION_OUTLINE_RANGE.min).max(CAPTION_OUTLINE_RANGE.max),
  shadow: z.boolean(),
  background: z.enum(CAPTION_BACKGROUNDS),
  uppercase: z.boolean(),
  snapToOnsets: z.boolean(),
  energySizing: z.boolean(),
  avoidFaces: z.boolean(),
  avoidText: z.boolean(),
  offsetMs: z.number().int().min(-MAX_CAPTION_OFFSET_MS).max(MAX_CAPTION_OFFSET_MS),
}).strict();

export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export const captionSourceSchema = z.object({
  artifactId: z.string().min(1),
  mediaHash: z.string().min(1),
  durationSeconds: z.number().finite().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().finite().positive(),
}).strict();

export type CaptionSource = z.infer<typeof captionSourceSchema>;

export const captionBindingsSchema = z.object({
  transcriptKey: z.string().min(1),
  vocalKey: z.string().min(1).nullable(),
  translationKey: z.string().min(1).nullable(),
}).strict();

export type CaptionBindings = z.infer<typeof captionBindingsSchema>;

export const captionDocumentSchema = z.object({
  version: z.literal(CAPTION_DOCUMENT_VERSION),
  language: z.string().min(1).max(16),
  sourceLanguage: z.string().max(16).nullable(),
  wordTiming: z.enum(["measured", "estimated"]),
  wordSegmentationVersion: z.literal(1).optional(),
  source: captionSourceSchema,
  bindings: captionBindingsSchema,
  aspect: aspectSchema,
  positions: captionPositionsSchema,
  style: captionStyleSchema,
  words: z.array(captionWordSchema).max(MAX_CAPTION_WORDS),
  phrases: z.array(captionPhraseSchema),
  nextId: z.number().int().positive(),
}).strict();

export type CaptionDocument = z.infer<typeof captionDocumentSchema>;

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  preset: "karaoke",
  motion: "pop",
  fontScale: 1,
  textColor: "#FFFFFF",
  highlightColor: "#FFE14D",
  outlineColor: "#000000",
  outlineWidth: 8,
  shadow: true,
  background: "blur",
  uppercase: false,
  snapToOnsets: true,
  energySizing: false,
  avoidFaces: true,
  avoidText: true,
  offsetMs: 0,
};

export const DEFAULT_CAPTION_ASPECT: CaptionAspect = "9:16";

export const CAPTION_ASPECT_SIZES: Record<CaptionAspect, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
};

export function nextCaptionId(document: Pick<CaptionDocument, "nextId">, prefix: "w" | "p"): { id: string; nextId: number } {
  return { id: `${prefix}${document.nextId}`, nextId: document.nextId + 1 };
}

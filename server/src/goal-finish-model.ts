import { z } from "zod";
import { graphicsDocumentSchema } from "./graphics/model.js";
import type { GraphicsFrame } from "./graphics/model.js";
import { GRAPHICS_STARTERS } from "./graphics/starters.js";
import { watermarkBurnDocument, watermarkTemplateDraws } from "./graphics/watermark-burn.js";
import { watermarkSlotValues } from "./graphics/watermark-profile.js";
import { profileWatermarkTimes, watermarkWindow } from "./watermark-timing.js";
import type { ShortFinishTitle } from "./goal-short-plan.js";

const profileSchema = z.object({
  platform: z.literal("tiktok"), mode: z.literal("burn"), handle: z.string(), profileUrl: z.string(),
  includePlatformIcon: z.boolean(), includeHandleBorder: z.boolean(),
  handlePaddingX: z.number(), handlePaddingY: z.number(), handleRounding: z.number(), scale: z.number().positive(),
  handlePlacement: z.enum(["above-title", "center", "above-qr", "on-qr", "below-qr"]),
  handleVerticalPercent: z.number(), handleStartSeconds: z.number().nonnegative(), handleEndSeconds: z.number().nonnegative().nullable(),
  handleOpacity: z.number().min(0).max(1), qrPosition: z.enum(["bottom-right", "auto"]), qrLeadSeconds: z.number().nonnegative().nullable(),
  qrOpacity: z.number().min(0).max(1), fadeSeconds: z.number().nonnegative(),
}).strict();

export const goalBrandingSchema = z.object({
  version: z.literal(1), revision: z.string(),
  profile: profileSchema,
  template: z.object({ id: z.string(), name: z.string(), updatedAt: z.string(), document: graphicsDocumentSchema }).strict().nullable(),
  starterId: z.enum(["tiktok-title", "lower-third", "headline", "credit", "watermark"]).nullable(),
  qrStartSeconds: z.number().nonnegative().nullable(), qrEndSeconds: z.number().nonnegative().nullable(),
  images: z.array(z.object({ artifactId: z.string(), mediaHash: z.string().nullable() }).strict()),
  credit: z.object({ text: z.string(), platform: z.string(), handle: z.string(), url: z.string().nullable() }).strict().nullable(),
}).strict();

export type GoalBranding = z.infer<typeof goalBrandingSchema>;

export const goalSoundtrackSchema = z.object({
  artifactId: z.string().uuid(), mediaHash: z.string().min(1), startSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(), hasAudio: z.boolean(),
}).strict();
export type GoalSoundtrack = z.infer<typeof goalSoundtrackSchema>;

export const goalFinishRecipeSchema = z.object({
  version: z.literal(1), branding: goalBrandingSchema.nullable(),
  audio: z.enum(["source", "generated", "mute", "mix"]), soundtrack: goalSoundtrackSchema.nullable(),
}).strict();
export type GoalFinishRecipe = z.infer<typeof goalFinishRecipeSchema>;

export function goalBrandingTitleSlots(branding: GoalBranding, enabled: boolean): { headline: boolean; secondary: boolean } {
  if (!enabled) return { headline: false, secondary: false };
  const document = branding.template?.document ?? GRAPHICS_STARTERS.find(value => value.id === branding.starterId)?.build({ width: 1080, height: 1920 }, branding.profile);
  if (!document) return { headline: true, secondary: true };
  const draws = watermarkTemplateDraws(document);
  return { headline: draws.headline, secondary: draws.headline && draws.secondary };
}

export function goalBrandingDocument(branding: GoalBranding, title: ShortFinishTitle | null, durationSeconds: number, frame: GraphicsFrame) {
  const template = branding.template?.document ?? GRAPHICS_STARTERS.find(value => value.id === branding.starterId)?.build(frame, branding.profile) ?? null;
  const draws = template ? watermarkTemplateDraws(template) : null;
  const times = profileWatermarkTimes({ ...branding.profile, qrStartSeconds: branding.qrStartSeconds, qrEndSeconds: branding.qrEndSeconds }, branding.profile, durationSeconds);
  const includeQr = draws?.qr ?? false;
  const includeHandle = draws?.handle ?? true;
  if (includeHandle && !branding.profile.handle.trim()) throw new Error("Choose a handle in the book branding settings.");
  if (includeQr && !branding.profile.profileUrl.trim()) throw new Error("Choose a QR destination in the book branding settings.");
  return watermarkBurnDocument({
    profile: branding.profile, frame, template, includeQr, includeHandle, corner: "bottom-right", patches: [], card: null,
    qrWindow: includeQr && !template ? watermarkWindow("QR watermark", durationSeconds, times.qrStartSeconds, times.qrEndSeconds) : { startSeconds: null, endSeconds: null },
    handleWindow: includeHandle && !template && branding.profile.handlePlacement !== "above-title"
      ? watermarkWindow("Handle watermark", durationSeconds, times.handleStartSeconds, times.handleEndSeconds) : { startSeconds: null, endSeconds: null },
    values: { ...watermarkSlotValues(branding.profile), ...(branding.credit ? { credit: branding.credit.text } : {}), ...(title ?? {}) },
  });
}

export function goalBrandingFindings(branding: GoalBranding, enabled: boolean, durationSeconds: number): { code: string; severity: "review"; text: string }[] {
  if (!enabled) return [];
  if (branding.images.some(image => !image.mediaHash)) return [{ code: "finish-branding", severity: "review", text: "The saved branding has a missing image. Restore it or choose another saved look before finishing." }];
  try {
    goalBrandingDocument(branding, null, durationSeconds, { width: 1080, height: 1920 });
    return [];
  } catch (error) {
    return [{ code: "finish-branding", severity: "review", text: error instanceof Error ? error.message : String(error) }];
  }
}

import type { CaptionDocument } from "../../captions/model.js";
import { CAPTION_ASPECT_SIZES } from "../../captions/model.js";

export function captionCompositionSize(document: CaptionDocument): { width: number; height: number } {
  return CAPTION_ASPECT_SIZES[document.aspect];
}

export function captionDurationInFrames(durationSeconds: number, fps: number): number {
  return Math.max(1, Math.round(durationSeconds * fps));
}

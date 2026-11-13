import { z } from "zod";
import { CAPTION_ASPECT_SIZES } from "../captions/model.js";
import type { GraphicsFrame } from "./model.js";
import type { GraphicsRegionFrame } from "./placement.js";

export const graphicsFrameSchema = z.object({
  aspect: z.enum(["original", "9:16", "1:1", "4:5", "16:9"]),
  fit: z.enum(["crop", "blur"]),
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
});
export type GraphicsFraming = z.infer<typeof graphicsFrameSchema>;
export const ORIGINAL_GRAPHICS_FRAME: GraphicsFraming = { aspect: "original", fit: "crop", focus: { x: 0.5, y: 0.5 } };

export function graphicsCanvas(source: GraphicsFrame, frame: GraphicsFraming): GraphicsFrame {
  return frame.aspect === "original" ? source : CAPTION_ASPECT_SIZES[frame.aspect];
}

export function graphicsAspectChanged(source: GraphicsFrame, frame: GraphicsFraming): boolean {
  const canvas = graphicsCanvas(source, frame);
  return Math.abs(source.width / source.height - canvas.width / canvas.height) > 0.001;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function graphicsVideoTransform(source: GraphicsFrame, canvas: GraphicsFrame, fit: "crop" | "blur", focus = ORIGINAL_GRAPHICS_FRAME.focus, zoom = 1) {
  const scale = (fit === "crop" ? Math.max : Math.min)(canvas.width / source.width, canvas.height / source.height) * zoom;
  const width = even(source.width * scale);
  const height = even(source.height * scale);
  const offset = (size: number, target: number, point: number) => size <= target
    ? Math.round((target - size) / 2)
    : -Math.round(Math.max(0, Math.min(size - target, size * point - target / 2)) / 2) * 2;
  return { width, height, left: offset(width, canvas.width, focus.x), top: offset(height, canvas.height, focus.y) };
}

export function graphicsFrameRegions(frames: readonly GraphicsRegionFrame[], source: GraphicsFrame, frame: GraphicsFraming): GraphicsRegionFrame[] {
  if (frame.aspect === "original") return [...frames];
  if (frame.fit === "blur") return frames.map((entry) => ({ ...entry, regions: [] }));
  const canvas = graphicsCanvas(source, frame);
  const transform = graphicsVideoTransform(source, canvas, "crop", frame.focus);
  return frames.map((entry) => ({ ...entry, regions: entry.regions.flatMap((region) => {
    const x = Math.max(0, region.x * transform.width + transform.left);
    const y = Math.max(0, region.y * transform.height + transform.top);
    const right = Math.min(canvas.width, (region.x + region.width) * transform.width + transform.left);
    const bottom = Math.min(canvas.height, (region.y + region.height) * transform.height + transform.top);
    return right <= x || bottom <= y ? [] : [{ ...region, x: x / canvas.width, y: y / canvas.height, width: (right - x) / canvas.width, height: (bottom - y) / canvas.height }];
  }) }));
}

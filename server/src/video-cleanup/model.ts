import { z } from "zod";

export const cleanupRegionSchema = z.object({
  id: z.string().min(1).max(80),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  start: z.number().nonnegative(),
  end: z.number().positive(),
}).strict().refine((r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001, "Keep the region inside the picture")
  .refine((r) => r.end > r.start, "The region must end after it starts");

export const cleanupRegionsSchema = z.array(cleanupRegionSchema).max(80)
  .refine((regions) => new Set(regions.map((r) => r.id)).size === regions.length, "Region IDs must be unique");
export const cleanupMethodSchema = z.enum(["lama", "fill"]);
export type CleanupRegion = z.infer<typeof cleanupRegionSchema>;
export type CleanupMethod = z.infer<typeof cleanupMethodSchema>;
export type CleanupBox = Pick<CleanupRegion, "x" | "y" | "width" | "height">;

export function validateCleanupRegions(value: unknown, duration: number): CleanupRegion[] {
  const regions = cleanupRegionsSchema.parse(value);
  if (!regions.length) throw new Error("Add or detect at least one region to remove.");
  if (regions.some((r) => r.end > duration + 0.001 || r.start >= duration)) throw new Error("Region times must be inside the video.");
  return regions;
}

export function cleanupFrameCount(regions: readonly CleanupRegion[], fps: number): number {
  const windows = regions.map(region => ({ start: Math.ceil(region.start * fps), end: Math.ceil(region.end * fps) }))
    .sort((left, right) => left.start - right.start);
  let frames = 0;
  let end = 0;
  for (const window of windows) {
    frames += Math.max(0, window.end - Math.max(end, window.start));
    end = Math.max(end, window.end);
  }
  return frames;
}

export function cleanupSampleTimes(duration: number, interval?: number): { times: number[]; interval: number } {
  const step = interval ?? Math.max(0.5, duration / 240);
  if (!Number.isFinite(step) || step < 0.25 || step > 30) throw new Error("Sample interval must be between 0.25 and 30 seconds.");
  const count = Math.ceil(duration / step);
  if (count > 600) throw new Error("Detection supports up to 600 samples. Increase sample_interval or trim the clip.");
  return { times: Array.from({ length: count }, (_, i) => Math.min(duration - 0.001, (i + 0.5) * step)), interval: step };
}

function intersection(a: CleanupBox, b: CleanupBox): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

function union(a: CleanupBox, b: CleanupBox): CleanupBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function trackCleanupRegions(frames: readonly { time: number; boxes: CleanupBox[] }[], interval: number, duration: number): CleanupRegion[] {
  const tracks: CleanupRegion[] = [];
  for (const frame of frames) {
    const used = new Set<string>();
    for (const box of frame.boxes) {
      const match = tracks.find((r) => !used.has(r.id) && frame.time - r.end <= interval * 0.51
        && intersection(r, box) / Math.min(r.width * r.height, box.width * box.height) > 0.5);
      const end = Math.min(duration, frame.time + interval / 2);
      if (match) {
        Object.assign(match, union(match, box), { end });
        used.add(match.id);
      } else {
        const region = { ...box, id: `region-${tracks.length + 1}`, start: Math.max(0, frame.time - interval / 2), end };
        tracks.push(region);
        used.add(region.id);
      }
    }
  }
  if (tracks.length > 80) throw new Error("Found more than 80 text regions. Trim the clip or mark the regions manually.");
  return tracks;
}

export function cleanupPixelBox(box: CleanupBox, width: number, height: number) {
  const left = Math.max(0, Math.floor(box.x * width));
  const top = Math.max(0, Math.floor(box.y * height));
  return { left, top, width: Math.min(width, Math.ceil((box.x + box.width) * width)) - left, height: Math.min(height, Math.ceil((box.y + box.height) * height)) - top };
}

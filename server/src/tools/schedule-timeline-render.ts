import type { ClipfirstFs } from "clipfirst-fs";
import { runRenderTimeline } from "./render-timeline.js";

const DEBOUNCE_MS = 1500;
const pending = new Map<string, NodeJS.Timeout>();

export function scheduleTimelineRender(fs: ClipfirstFs, projectSlug: string): void {
  const existing = pending.get(projectSlug);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(projectSlug);
    runRenderTimeline(fs, projectSlug).catch(() => {});
  }, DEBOUNCE_MS);

  timer.unref?.();
  pending.set(projectSlug, timer);
}

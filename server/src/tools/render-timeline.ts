import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { findAudioFile } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { readTimeline } from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

const TIMELINE_FPS = 30;
const RENDER_FILENAMES = {
  landscape: "landscape.mp4",
  portrait: "portrait.mp4",
  square: "square.mp4",
} as const;

type Orientation = keyof typeof RENDER_FILENAMES;

type ResolvedSlot = {
  slug: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  assetDir: string;
};

type ResolvedAudioOverlay = {
  id: string;
  slug: string;
  audioPath: string;
  startMs: number;
  durationMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
};

export type RenderTimelineOutcome =
  | { status: "enqueued"; jobId: string; slotCount: number; orientation: Orientation }
  | { status: "missing_renders"; orientation: Orientation; missingSlugs: string[]; message: string }
  | { status: "empty"; message: string }
  | { status: "error"; message: string };

export async function runRenderTimeline(
  engine: Engine,
  bookId: string,
  orientationOverride?: Orientation,
): Promise<RenderTimelineOutcome> {
  const timeline = readTimeline(engine);
  const orientation = orientationOverride ?? timeline.render;
  if (timeline.slots.length === 0) {
    return { status: "empty", message: "Timeline has no assigned artifacts." };
  }
  const renderFilename = RENDER_FILENAMES[orientation];
  const resolvedSlots: ResolvedSlot[] = [];
  const missingSlugs: string[] = [];
  for (const slot of timeline.slots) {
    const artifact = engine.artifacts.get(slot.artifactId);
    if (!artifact.ok) return { status: "error", message: artifact.error.message };
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    if (!manifest.ok) return { status: "error", message: manifest.error.message };
    if (!manifest.value.files.some((file) => file.name === renderFilename)) {
      missingSlugs.push(artifact.value.slug);
      continue;
    }
    resolvedSlots.push({
      slug: artifact.value.slug,
      volume: slot.volume ?? 100,
      fadeIn: slot.audioFadeIn ?? 0,
      fadeOut: slot.audioFadeOut ?? 0,
      assetDir: manifest.value.path,
    });
  }
  if (missingSlugs.length > 0) {
    return {
      status: "missing_renders",
      orientation,
      missingSlugs,
      message: `Missing ${renderFilename} for ${missingSlugs.join(", ")}`,
    };
  }
  const resolvedAudio: ResolvedAudioOverlay[] = [];
  for (const clip of timeline.audio) {
    const artifact = engine.artifacts.get(clip.artifactId);
    if (!artifact.ok) return { status: "error", message: artifact.error.message };
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    if (!manifest.ok) return { status: "error", message: manifest.error.message };
    const audioFile = findAudioFile(manifest.value.files, artifact.value.slug);
    if (!audioFile) return { status: "error", message: `No audio file found in ${artifact.value.slug}` };
    resolvedAudio.push({
      id: clip.id,
      slug: artifact.value.slug,
      audioPath: join(manifest.value.path, audioFile.name),
      startMs: Math.round((clip.startFrame / TIMELINE_FPS) * 1000),
      durationMs: Math.round((clip.durationFrames / TIMELINE_FPS) * 1000),
      volume: (clip.volume ?? 100) / 100,
      fadeInMs: clip.fadeIn ?? 0,
      fadeOutMs: clip.fadeOut ?? 0,
    });
  }
  const jobId = `render-timeline-${bookId}-${Date.now()}`;
  await queue.enqueue(jobId, {
    type: "render_timeline",
    bookId,
    orientation,
    resolvedSlots,
    resolvedAudio,
  });
  return { status: "enqueued", jobId, slotCount: resolvedSlots.length, orientation };
}

export function renderTimelineDef(engine: Engine): ToolDef {
  return {
    name: "render_timeline",
    description: "Render the selected book's typed v2 timeline",
    schema: {
      book_id: z.string().uuid(),
      orientation: z.enum(["landscape", "portrait", "square"]).optional(),
    },
    handler: async (args) => {
      const outcome = await runRenderTimeline(
        engine,
        String(args.book_id),
        args.orientation as Orientation | undefined,
      );
      if (outcome.status === "error" || outcome.status === "empty") {
        return { isError: true, content: [{ type: "text", text: outcome.message }] };
      }
      if (outcome.status === "missing_renders") {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              status: outcome.status,
              orientation: outcome.orientation,
              missing_slugs: outcome.missingSlugs,
              message: outcome.message,
            }),
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: outcome.status,
            job_id: outcome.jobId,
            slot_count: outcome.slotCount,
            orientation: outcome.orientation,
          }),
        }],
      };
    },
  };
}

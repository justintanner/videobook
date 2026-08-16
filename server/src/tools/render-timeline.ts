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
  artifactId: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  assetDir: string;
};

type ResolvedAudioOverlay = {
  id: string;
  artifactId: string;
  audioPath: string;
  startMs: number;
  durationMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
};

export type RenderTimelineOutcome =
  | { status: "enqueued"; jobId: string; slotCount: number; orientation: Orientation }
  | { status: "missing_renders"; orientation: Orientation; missingArtifactIds: string[]; message: string }
  | { status: "empty"; message: string }
  | { status: "error"; message: string };

async function runRenderTimeline(
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
  const missingArtifactIds: string[] = [];
  for (const slot of timeline.slots) {
    const artifact = engine.artifacts.get(slot.artifactId);
    if (!artifact.ok) return { status: "error", message: artifact.error.message };
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    if (!manifest.ok) return { status: "error", message: manifest.error.message };
    if (!manifest.value.files.some((file) => file.name === renderFilename)) {
      missingArtifactIds.push(artifact.value.artifactId);
      continue;
    }
    resolvedSlots.push({
      artifactId: artifact.value.artifactId,
      volume: slot.volume ?? 100,
      fadeIn: slot.audioFadeIn ?? 0,
      fadeOut: slot.audioFadeOut ?? 0,
      assetDir: manifest.value.path,
    });
  }
  if (missingArtifactIds.length > 0) {
    return {
      status: "missing_renders",
      orientation,
      missingArtifactIds,
      message: `Missing ${renderFilename} for ${missingArtifactIds.join(", ")}`,
    };
  }
  const resolvedAudio: ResolvedAudioOverlay[] = [];
  for (const clip of timeline.audio) {
    const artifact = engine.artifacts.get(clip.artifactId);
    if (!artifact.ok) return { status: "error", message: artifact.error.message };
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    if (!manifest.ok) return { status: "error", message: manifest.error.message };
    const audioFile = findAudioFile(manifest.value.files, artifact.value.kind);
    if (!audioFile) return { status: "error", message: `No audio file found in ${artifact.value.artifactId}` };
    resolvedAudio.push({
      id: clip.id,
      artifactId: artifact.value.artifactId,
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
              missing_artifact_ids: outcome.missingArtifactIds,
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

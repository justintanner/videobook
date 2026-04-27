import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "../media-files.js";
import { readStoredRenderDefaults } from "./sync.js";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";

const TIMELINE_FPS = 30;

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type TimelineAudioClip = {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

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

type MissingSlot = {
  slug: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
  hasElevenlabs: boolean;
};

export type RenderTimelineOutcome =
  | { status: "enqueued"; jobId: string; slotCount: number; orientation: Orientation }
  | {
      status: "prerender_started";
      orientation: Orientation;
      prerenderJobs: Array<{ slug: string; jobId: string }>;
    }
  | { status: "empty"; message: string }
  | { status: "no_timeline"; message: string }
  | { status: "error"; message: string };

const LANDSCAPE_RENDER = "landscape.mp4";
const PORTRAIT_RENDER = "portrait.mp4";
const SQUARE_RENDER = "square.mp4";

export async function runRenderTimeline(
  fs: ClipfirstFs,
  projectSlug: string,
): Promise<RenderTimelineOutcome> {
  const timelineResult = await fs.readProjectMeta<
    { slots: TimelineSlot[]; audio?: TimelineAudioClip[]; render?: string } | TimelineSlot[]
  >("timeline", projectSlug);
  if (!timelineResult.ok) {
    if (timelineResult.error.code === "NOT_FOUND") {
      return {
        status: "no_timeline",
        message: "No timeline found for this project. Use edit_timeline first.",
      };
    }
    return { status: "error", message: timelineResult.error.message };
  }

  const raw = timelineResult.value;
  const slots = (Array.isArray(raw) ? raw : raw.slots).filter((s) => s.slug);
  const audioClips: TimelineAudioClip[] = Array.isArray(raw) ? [] : (raw.audio ?? []);
  const orientation = (Array.isArray(raw) ? "landscape" : (raw.render ?? "landscape")) as Orientation;
  if (slots.length === 0) {
    return { status: "empty", message: "Timeline has no slots with assets assigned." };
  }

  const renderFilename =
    orientation === "portrait" ? PORTRAIT_RENDER : orientation === "square" ? SQUARE_RENDER : LANDSCAPE_RENDER;

  const resolvedSlots: ResolvedSlot[] = [];
  const missingSlots: MissingSlot[] = [];

  for (const slot of slots) {
    const manifestResult = await fs.getManifest(slot.slug, projectSlug, { includeDotfiles: true });
    if (!manifestResult.ok) {
      return {
        status: "error",
        message: `Asset ${slot.slug} not found: ${manifestResult.error.message}`,
      };
    }

    const manifest = manifestResult.value;
    const files = manifest.files;

    if (files.some((f) => f.name === renderFilename)) {
      resolvedSlots.push({
        slug: slot.slug,
        volume: slot.volume ?? 100,
        fadeIn: slot.audioFadeIn ?? 0,
        fadeOut: slot.audioFadeOut ?? 0,
        assetDir: manifest.path,
      });
      continue;
    }

    const videoFile = findVideoFile(files);
    if (!videoFile) {
      return {
        status: "error",
        message: `Asset ${slot.slug} has no source video file — cannot prerender ${renderFilename}.`,
      };
    }

    missingSlots.push({
      slug: slot.slug,
      assetDir: manifest.path,
      videoPath: join(manifest.path, videoFile.name),
      videoFilename: videoFile.name,
      hasElevenlabs: files.some((f) => f.name === "elevenlabs.json"),
    });
  }

  if (missingSlots.length > 0) {
    const prerenderJobs: Array<{ slug: string; jobId: string }> = [];
    for (const slot of missingSlots) {
      const stored = await readStoredRenderDefaults(fs, slot.slug, projectSlug, orientation);
      const jobId = `final-prerender-${slot.slug}-${orientation}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "render_project",
        projectSlug: projectSlug,
        orientation,
        assets: [
          {
            assetId: slot.slug,
            assetDir: slot.assetDir,
            videoPath: slot.videoPath,
            videoFilename: slot.videoFilename,
            hasElevenlabs: slot.hasElevenlabs,
          },
        ],
        subtitlesEnabled: slot.hasElevenlabs ? (stored.subtitlesEnabled as boolean) : false,
        highlightStyle: stored.highlightStyle as string,
        position: stored.position as string,
        fontSize: stored.fontSize as string,
        textColor: stored.textColor as string,
        highlightColor: stored.highlightColor as string,
        audioFadeIn: stored.audioFadeIn as number,
        audioFadeOut: stored.audioFadeOut as number,
        audioVolume: stored.audioVolume as number,
        osgImagePath: (stored.osgImagePath as string | null) ?? null,
        osgAssetId: (stored.osgAssetId as string | null) ?? null,
        osgPosition: stored.osgPosition as string,
        backgroundMode: stored.backgroundMode as string,
      });
      prerenderJobs.push({ slug: slot.slug, jobId });
    }

    return { status: "prerender_started", orientation, prerenderJobs };
  }

  const resolvedAudio: ResolvedAudioOverlay[] = [];
  for (const clip of audioClips) {
    const manifestResult = await fs.getManifest(clip.slug, projectSlug);
    if (!manifestResult.ok) {
      return {
        status: "error",
        message: `Audio asset ${clip.slug} not found: ${manifestResult.error.message}`,
      };
    }
    const manifest = manifestResult.value;
    const audioFile = findAudioFile(manifest.files, clip.slug);
    if (!audioFile) {
      return {
        status: "error",
        message: `Audio asset ${clip.slug} has no audio file.`,
      };
    }
    resolvedAudio.push({
      id: clip.id,
      slug: clip.slug,
      audioPath: join(manifest.path, audioFile.name),
      startMs: Math.round((clip.startFrame / TIMELINE_FPS) * 1000),
      durationMs: Math.round((clip.durationFrames / TIMELINE_FPS) * 1000),
      volume: (clip.volume ?? 100) / 100,
      fadeInMs: clip.fadeIn ?? 0,
      fadeOutMs: clip.fadeOut ?? 0,
    });
  }

  const jobId = `render-timeline-${projectSlug}-${Date.now()}`;

  await queue.enqueue(jobId, {
    type: "render_timeline",
    projectSlug: projectSlug,
    orientation,
    resolvedSlots,
    resolvedAudio,
  });

  return { status: "enqueued", jobId, slotCount: resolvedSlots.length, orientation };
}

export function renderTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render_timeline",
    description:
      "Concatenate rendered video clips in timeline order into a single final output. If any slot is missing its per-orientation render, this tool enqueues the per-slot renders first and returns status 'prerender_started' — re-invoke render_timeline once they finish. Writes the concat output to the 'final' singleton asset.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const outcome = await runRenderTimeline(fs, project_slug);

      switch (outcome.status) {
        case "no_timeline":
        case "error":
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: outcome.message }],
          };
        case "empty":
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: outcome.message }],
          };
        case "prerender_started":
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "prerender_started",
                  orientation: outcome.orientation,
                  prerender_jobs: outcome.prerenderJobs.map((j) => ({
                    slug: j.slug,
                    job_id: j.jobId,
                  })),
                  message: `Started ${outcome.prerenderJobs.length} per-slot render(s). Call render_timeline again once they finish.`,
                }),
              },
            ],
          };
        case "enqueued":
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  job_id: outcome.jobId,
                  status: "enqueued",
                  slot_count: outcome.slotCount,
                  orientation: outcome.orientation,
                }),
              },
            ],
          };
      }
    },
  };
}

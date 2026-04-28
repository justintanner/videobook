import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "../media-files.js";
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

export type RenderTimelineOutcome =
  | { status: "enqueued"; jobId: string; slotCount: number; orientation: Orientation }
  | { status: "missing_renders"; orientation: Orientation; missingSlugs: string[]; message: string }
  | { status: "empty"; message: string }
  | { status: "no_timeline"; message: string }
  | { status: "error"; message: string };

const LANDSCAPE_RENDER = "landscape.mp4";
const PORTRAIT_RENDER = "portrait.mp4";
const SQUARE_RENDER = "square.mp4";

export async function runRenderTimeline(
  fs: ClipfirstFs,
  projectSlug: string,
  orientationOverride?: Orientation,
): Promise<RenderTimelineOutcome> {
  const timelineResult = await fs.readProjectMeta<
    {
      slots: TimelineSlot[];
      audio?: TimelineAudioClip[];
      render?: string;
      currentOrientation?: string;
    } | TimelineSlot[]
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
  const currentTab = !Array.isArray(raw) && raw.currentOrientation;
  const tabOrientation: Orientation | undefined =
    currentTab === "portrait" || currentTab === "square" || currentTab === "landscape"
      ? currentTab
      : undefined;
  const renderField = !Array.isArray(raw) ? (raw.render as Orientation | undefined) : undefined;
  const orientation: Orientation =
    orientationOverride ?? tabOrientation ?? renderField ?? "landscape";
  if (slots.length === 0) {
    return { status: "empty", message: "Timeline has no slots with assets assigned." };
  }

  const renderFilename =
    orientation === "portrait" ? PORTRAIT_RENDER : orientation === "square" ? SQUARE_RENDER : LANDSCAPE_RENDER;

  const resolvedSlots: ResolvedSlot[] = [];
  const missingSlugs: string[] = [];

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

    missingSlugs.push(slot.slug);
  }

  if (missingSlugs.length > 0) {
    return {
      status: "missing_renders",
      orientation,
      missingSlugs,
      message:
        `Cannot render timeline: ${missingSlugs.length} slot(s) missing ${renderFilename} — ` +
        `${missingSlugs.join(", ")}. Run /render on each before /final.`,
    };
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
      "Concatenate rendered video clips in timeline order into a single final output. Requires every slot to already have its per-orientation render — if any are missing, returns status 'missing_renders' listing the slugs that need /render first. Writes the concat output to the 'final' singleton asset. Orientation precedence: explicit arg → timeline.currentOrientation (active tab) → timeline.render → landscape.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Override the orientation to render"),
    },
    handler: async (args) => {
      const { project_slug, orientation } = args as {
        project_slug: string;
        orientation?: Orientation;
      };
      const outcome = await runRenderTimeline(fs, project_slug, orientation);

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
        case "missing_renders":
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "missing_renders",
                  orientation: outcome.orientation,
                  missing_slugs: outcome.missingSlugs,
                  message: outcome.message,
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

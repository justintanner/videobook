import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { readStoredRenderDefaults } from "./sync.js";
import type { ToolDef } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type ResolvedSlot = {
  slug: string;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  assetDir: string;
};

type MissingSlot = {
  slug: string;
  assetDir: string;
  videoPath: string;
  videoFilename: string;
  hasElevenlabs: boolean;
};

const LANDSCAPE_RENDER = "landscape.mp4";
const PORTRAIT_RENDER = "portrait.mp4";
const SQUARE_RENDER = "square.mp4";

export function renderTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render_timeline",
    description:
      "Concatenate rendered video clips in timeline order into a single final output. If any slot is missing its per-orientation render, this tool enqueues the per-slot renders first and returns status 'prerender_started' — re-invoke render_timeline once they finish. Writes the concat output to the 'final' singleton asset.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as {
        project_slug: string;
      };

      const timelineResult = await fs.readProjectMeta<{ slots: TimelineSlot[]; render?: string } | TimelineSlot[]>("timeline", project_slug);
      if (!timelineResult.ok) {
        if (timelineResult.error.code === "NOT_FOUND") {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "No timeline found for this project. Use edit_timeline first." }],
          };
        }
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: timelineResult.error.message }],
        };
      }

      const raw = timelineResult.value;
      const slots = (Array.isArray(raw) ? raw : raw.slots).filter((s) => s.slug);
      const orientation = (Array.isArray(raw) ? "landscape" : (raw.render ?? "landscape")) as "landscape" | "portrait" | "square";
      if (slots.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Timeline has no slots with assets assigned." }],
        };
      }

      const renderFilename = orientation === "portrait" ? PORTRAIT_RENDER : orientation === "square" ? SQUARE_RENDER : LANDSCAPE_RENDER;

      const resolvedSlots: ResolvedSlot[] = [];
      const missingSlots: MissingSlot[] = [];

      for (const slot of slots) {
        const manifestResult = await fs.getManifest(slot.slug, project_slug, { includeDotfiles: true });
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Asset ${slot.slug} not found: ${manifestResult.error.message}`,
            }],
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
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Asset ${slot.slug} has no source video file — cannot prerender ${renderFilename}.`,
            }],
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
        const prerenderJobs: Array<{ slug: string; job_id: string }> = [];
        for (const slot of missingSlots) {
          const stored = await readStoredRenderDefaults(fs, slot.slug, project_slug, orientation);
          const jobId = `final-prerender-${slot.slug}-${orientation}-${Date.now()}`;
          await queue.enqueue(jobId, {
            type: "render_project",
            projectSlug: project_slug,
            orientation,
            assets: [{
              assetId: slot.slug,
              assetDir: slot.assetDir,
              videoPath: slot.videoPath,
              videoFilename: slot.videoFilename,
              hasElevenlabs: slot.hasElevenlabs,
            }],
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
          prerenderJobs.push({ slug: slot.slug, job_id: jobId });
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "prerender_started",
              orientation,
              prerender_jobs: prerenderJobs,
              message: `Started ${prerenderJobs.length} per-slot render(s). Call render_timeline again once they finish.`,
            }),
          }],
        };
      }

      const jobId = `render-timeline-${project_slug}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "render_timeline",
        projectSlug: project_slug,
        orientation,
        resolvedSlots,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            job_id: jobId,
            status: "enqueued",
            slot_count: resolvedSlots.length,
            orientation,
          }),
        }],
      };
    },
  };
}

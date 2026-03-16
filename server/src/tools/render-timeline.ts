import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

const LANDSCAPE_RENDER = "landscape.mp4";
const PORTRAIT_RENDER = "portrait.mp4";
const SQUARE_RENDER = "square.mp4";

export function renderTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render_timeline",
    description:
      "Concatenate rendered video clips in timeline order into a single final output. Each slot must have a rendered video (landscape.mp4, portrait.mp4, or square.mp4). Writes output to the 'final' singleton asset.",
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

      const resolvedSlots: Array<{
        slug: string;
        volume: number;
        fadeIn: number;
        fadeOut: number;
        assetDir: string;
      }> = [];

      for (const slot of slots) {
        const manifestResult = await fs.getManifest(slot.slug, project_slug);
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Asset ${slot.slug} not found: ${manifestResult.error.message}`,
            }],
          };
        }

        const hasRender = manifestResult.value.files.some((f) => f.name === renderFilename);
        if (!hasRender) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Asset ${slot.slug} is missing ${renderFilename}. Render it first with render.`,
            }],
          };
        }

        resolvedSlots.push({
          slug: slot.slug,
          volume: slot.volume ?? 100,
          fadeIn: slot.audioFadeIn ?? 0,
          fadeOut: slot.audioFadeOut ?? 0,
          assetDir: manifestResult.value.path,
        });
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

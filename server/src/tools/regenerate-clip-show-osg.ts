import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { regenerateClipShowOsg } from "../plan-clip-show.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  segment_index: z.number().int().min(0).describe("Zero-based joke (segment) index"),
  osg_index: z.number().int().min(0).describe("Zero-based OSG index within the joke"),
  image_prompt: z
    .string()
    .optional()
    .describe("New text-to-image prompt. Defaults to the OSG's existing prompt when omitted."),
  treatment: z.string().optional().describe("New treatment id. Defaults to the OSG's existing treatment."),
};

export function regenerateClipShowOsgDef(fs: VideocityFs): ToolDef {
  return {
    name: "regenerate_clip_show_osg",
    description:
      "Regenerate one on-screen graphic (OSG) image: create a fresh img-* asset, enqueue its text-to-image job (Nano Banana Pro, 16:9), and point the OSG at it. Optionally with a new image_prompt and/or treatment. Writes plan/index.md and plan/.plan.json and returns the updated plan immediately (the image fills in via the normal sync loop).",
    schema,
    handler: async (args) => {
      const { project_slug, segment_index, osg_index, image_prompt, treatment } = args as {
        project_slug: string;
        segment_index: number;
        osg_index: number;
        image_prompt?: string;
        treatment?: string;
      };

      if (!process.env.FAL_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }],
        };
      }

      try {
        const sidecar = await regenerateClipShowOsg(fs, {
          projectSlug: project_slug,
          segmentIndex: segment_index,
          osgIndex: osg_index,
          imagePrompt: image_prompt ?? null,
          treatment: treatment ?? null,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ asset_id: "plan", sidecar }) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: msg }],
        };
      }
    },
  };
}

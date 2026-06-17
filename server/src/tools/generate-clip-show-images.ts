import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { generateClipShowImages } from "../plan-clip-show.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
};

export function generateClipShowImagesDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_clip_show_images",
    description:
      "Generate the still-missing on-screen-graphic (OSG) images for the active Clip Show plan: for every generated OSG that has a prompt but no image yet, create an img-* asset and enqueue its text-to-image job (Nano Banana Pro, 16:9). Image generation is opt-in — plan creation and joke regeneration only write prompts; this fills them in. Idempotent (uploads and already-generated OSGs are left alone). Writes plan/index.md and plan/.plan.json and returns the updated plan immediately (images fill in via the normal sync loop).",
    schema,
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      if (!process.env.FAL_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }],
        };
      }

      try {
        const sidecar = await generateClipShowImages(fs, { projectSlug: project_slug });
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

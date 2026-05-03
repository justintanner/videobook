import type { ClipfirstFs } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const generateKlingV3ProI2vFalSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Video description (max 2500 chars)"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  end_frame_slug: z.string().optional().describe("Optional end frame image asset"),
  duration: z.string().optional().describe("Video duration in seconds"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio"),
  negative_prompt: z.string().optional().describe("Things to avoid (max 2500 chars)"),
  cfg_scale: z.number().min(0).max(1).optional().describe("Classifier-free guidance scale (0-1)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKlingV3ProI2vFalSchema>;

export function generateKlingV3ProI2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_kling_v3_pro_i2v_fal",
    description: "Generate a video via fal.ai using Kling Video v3 Pro image-to-video. Requires a first-frame image; optional end frame for transition control. Creates a new vid- asset and enqueues a background job.",
    schema: generateKlingV3ProI2vFalSchema,
    handler: async (args) => {
      const { project_slug, prompt, first_frame_slug, end_frame_slug, duration, generate_audio, negative_prompt, cfg_scale } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const slugs = end_frame_slug ? [first_frame_slug, end_frame_slug] : [first_frame_slug];
      const resolved = await resolveImageSlugs(fs, slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const nameSource = prompt ?? first_frame_slug;
      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "kling-3.0/video/pro")}-${slugify(nameSource) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "kling-3.0/video/pro")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_kling_v3_pro_i2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(cfg_scale !== undefined ? { cfg_scale } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

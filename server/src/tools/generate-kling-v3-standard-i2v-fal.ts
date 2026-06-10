import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalKlingVideoV3StandardImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalKlingVideoV3StandardImageToVideoRequestSchema.shape;
const shotTypeOptions = base.shot_type.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Video description (max 2500 chars)"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  end_frame_slug: z.string().optional().describe("Optional end frame image asset"),
  duration: z.string().optional().describe("Video duration as string (model-specific)"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio"),
  shot_type: z.enum(shotTypeOptions).optional().describe("Shot type"),
  negative_prompt: z.string().optional().describe("Things to avoid"),
  cfg_scale: z.number().min(0).max(2).optional().describe("CFG scale (0-2)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateKlingV3StandardI2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_kling_v3_standard_i2v_fal",
    description: "Generate a video via fal.ai using Kling Video v3 Standard from a first-frame image (optional end frame). Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, first_frame_slug, end_frame_slug, duration, generate_audio, shot_type, negative_prompt, cfg_scale } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const slugs = end_frame_slug ? [first_frame_slug, end_frame_slug] : [first_frame_slug];
      const resolved = await resolveImageSlugs(fs, slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "kling-3.0/video/std")}-${slugify(prompt ?? "") || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "kling-3.0/video/std")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_kling_v3_standard_i2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(shot_type !== undefined ? { shot_type } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(cfg_scale !== undefined ? { cfg_scale } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

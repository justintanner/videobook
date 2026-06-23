import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7ImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField } from "./schema-from-apicity.js";

const base = FalWanV2p7ImageToVideoRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  end_frame_slug: z.string().optional().describe("Optional end frame image asset"),
  resolution: apicityField(base.resolution, "Output resolution"),
  duration: z.number().int().min(2).max(15).optional().describe("Video duration in seconds (2-15)"),
  negative_prompt: z.string().optional().describe("Things to avoid"),
  enable_prompt_expansion: z.boolean().optional().describe("Enable prompt expansion"),
  enable_safety_checker: z.boolean().optional().describe("Enable safety checker"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27I2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_wan27_i2v_fal",
    description: "Generate a video via fal.ai using Alibaba Wan v2.7 from a first-frame image (optional end frame). Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, first_frame_slug, end_frame_slug, resolution, duration, negative_prompt, enable_prompt_expansion, enable_safety_checker, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const slugs = end_frame_slug ? [first_frame_slug, end_frame_slug] : [first_frame_slug];
      const resolved = await resolveImageSlugs(fs, slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "wan/2-7-image-to-video")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-image-to-video")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_i2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(enable_prompt_expansion !== undefined ? { enable_prompt_expansion } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { FalKlingVideoV3StandardTextToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const base = FalKlingVideoV3StandardTextToVideoRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Video description (max 2500 chars)", { required: true }),
  duration: apicityStringField(base.duration, "Video duration as string (model-specific)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  generate_audio: apicityField(base.generate_audio, "Generate accompanying audio"),
  shot_type: apicityField(base.shot_type, "Shot type"),
  negative_prompt: apicityStringField(base.negative_prompt, "Things to avoid"),
  cfg_scale: apicityField(base.cfg_scale, "CFG scale (0-2)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateKlingV3StandardT2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_fal_kling_video_v3_standard_text_to_video",
    description: "Generate a video via fal.ai using Kling Video v3 Standard from a text prompt. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, duration, aspect_ratio, generate_audio, shot_type, negative_prompt, cfg_scale } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "kling-3.0/video/std")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "kling-3.0/video/std")}-t2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_kling_v3_standard_t2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(shot_type !== undefined ? { shot_type } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(cfg_scale !== undefined ? { cfg_scale } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

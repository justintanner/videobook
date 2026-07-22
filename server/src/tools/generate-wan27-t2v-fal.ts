import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7TextToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const base = FalWanV2p7TextToVideoRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Video description", { required: true }),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  duration: apicityField(base.duration, "Video duration in seconds (2-15)"),
  negative_prompt: apicityStringField(base.negative_prompt, "Things to avoid"),
  enable_prompt_expansion: apicityField(base.enable_prompt_expansion, "Enable prompt expansion"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27T2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_fal_wan_2_7_text_to_video",
    description: "Generate a video via fal.ai using Alibaba Wan v2.7 from a text prompt only. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, aspect_ratio, resolution, duration, negative_prompt, enable_prompt_expansion, enable_safety_checker, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "wan/2-7-text-to-video")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-text-to-video")}-t2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_t2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(enable_prompt_expansion !== undefined ? { enable_prompt_expansion } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

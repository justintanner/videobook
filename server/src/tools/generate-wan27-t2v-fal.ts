import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7TextToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";

const base = FalWanV2p7TextToVideoRequestSchema.shape;
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution"),
  duration: z.number().int().min(2).max(15).optional().describe("Video duration in seconds (2-15)"),
  negative_prompt: z.string().optional().describe("Things to avoid"),
  enable_prompt_expansion: z.boolean().optional().describe("Enable prompt expansion"),
  enable_safety_checker: z.boolean().optional().describe("Enable safety checker"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27T2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_t2v_fal",
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

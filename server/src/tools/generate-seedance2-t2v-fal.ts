import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { FalSeedance2p0TextToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { QUEUED_TASK_ID } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";

const base = FalSeedance2p0TextToVideoRequestSchema.shape;
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];
const durationOptions = base.duration.unwrap().options as readonly [string, ...string[]];
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];

const generateSeedance2T2vFalSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution"),
  duration: z.enum(durationOptions).optional().describe("Video duration in seconds"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio"),
  seed: z.number().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedance2T2vFalSchema>;

export function generateSeedance2T2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_t2v_fal",
    description: "Generate a video via fal.ai using ByteDance Seedance 2.0 from a text prompt only. Creates a new vid- asset and enqueues a background job.",
    schema: generateSeedance2T2vFalSchema,
    handler: async (args) => {
      const { project_slug, prompt, resolution, duration, aspect_ratio, generate_audio, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("vid", `seedance2-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      {
        const _ptResult = await fs.pendingTasks.write(project_slug, {
          taskId: QUEUED_TASK_ID,
          taskType: "fal_seedance2_t2v",
          assetId: vidAssetId,
          assetDir: vidAssetDir,
          meta: { prompt, mode: "t2v", sourceImageIds: [] },
        });
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      }

      const jobId = `fal-seedance2-t2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedance2_t2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

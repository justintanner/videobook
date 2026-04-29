import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { FalSeedance2p0ImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { QUEUED_TASK_ID } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

const base = FalSeedance2p0ImageToVideoRequestSchema.shape;
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];
const durationOptions = base.duration.unwrap().options as readonly [string, ...string[]];
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];

const generateSeedance2I2vFalSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  first_frame_slug: z.string().describe("First frame image asset (e.g., @img-start)"),
  end_frame_slug: z.string().optional().describe("Optional end frame image asset (fal-native name)"),
  last_frame_slug: z.string().optional().describe("Optional last frame image asset (alias for end_frame_slug used by the dual-provider UI)"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution"),
  duration: z.enum(durationOptions).optional().describe("Video duration in seconds"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio"),
  seed: z.number().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedance2I2vFalSchema>;

export function generateSeedance2I2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_i2v_fal",
    description: "Generate a video via fal.ai using ByteDance Seedance 2.0 from a first-frame image (optional end frame). Creates a new vid- asset and enqueues a background job.",
    schema: generateSeedance2I2vFalSchema,
    handler: async (args) => {
      const { project_slug, prompt, first_frame_slug, end_frame_slug, last_frame_slug, resolution, duration, aspect_ratio, generate_audio, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const endSlug = end_frame_slug ?? last_frame_slug;
      const slugs = endSlug ? [first_frame_slug, endSlug] : [first_frame_slug];
      const resolved = await resolveImageSlugs(fs, slugs, project_slug);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const assetResult = await fs.createAsset("vid", `seedance2-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      {
        const _ptResult = await fs.pendingTasks.write(project_slug, {
          taskId: QUEUED_TASK_ID,
          taskType: "fal_seedance2_i2v",
          assetId: vidAssetId,
          assetDir: vidAssetDir,
          meta: { prompt, mode: "i2v", sourceImageIds: resolved.sourceImageIds },
        });
        if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      }

      const jobId = `fal-seedance2-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedance2_i2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

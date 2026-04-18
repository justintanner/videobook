import type { ClipfirstFs } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { FalVeo3p1TextToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";

const base = FalVeo3p1TextToVideoRequestSchema.shape;
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];
const durationOptions = base.duration.unwrap().options as readonly [string, ...string[]];
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];
const safetyToleranceOptions = base.safety_tolerance.unwrap().options as readonly [string, ...string[]];

const generateVeo31T2vFalSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (max 20000 chars)"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  duration: z.enum(durationOptions).optional().describe("Video duration"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio"),
  negative_prompt: z.string().optional().describe("Things to avoid"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
  auto_fix: z.boolean().optional().describe("Auto-fix the prompt"),
  safety_tolerance: z.enum(safetyToleranceOptions).optional().describe("Safety tolerance 1-6"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateVeo31T2vFalSchema>;

export function generateVeo31T2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_veo31_t2v_fal",
    description: "Generate a video via fal.ai using Google Veo 3.1 from a text prompt only. Creates a new vid- asset and enqueues a background job.",
    schema: generateVeo31T2vFalSchema,
    handler: async (args) => {
      const { project_slug, prompt, aspect_ratio, duration, resolution, generate_audio, negative_prompt, seed, auto_fix, safety_tolerance } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const assetResult = await fs.createAsset("vid", `veo31-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "fal_veo31_t2v",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { prompt, mode: "t2v", sourceImageIds: [] },
      });

      const jobId = `fal-veo31-t2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_veo31_t2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(auto_fix !== undefined ? { auto_fix } : {}),
        ...(safety_tolerance !== undefined ? { safety_tolerance } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

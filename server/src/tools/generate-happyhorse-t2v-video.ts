import type { ClipfirstFs } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { HappyHorseAspectRatioSchema, HappyHorseResolutionSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateHappyhorseT2vVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (max 5000 chars / 2500 Chinese chars)"),
  resolution: z.enum(HappyHorseResolutionSchema.options).optional().describe("Output resolution: 720p / 1080p (default 1080p)"),
  aspect_ratio: z.enum(HappyHorseAspectRatioSchema.options).optional().describe("Output aspect ratio (default 16:9)"),
  duration: z.string().optional().describe("Video duration in seconds (3-15, default 5)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseT2vVideoSchema>;

export function generateHappyhorseT2vVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_happyhorse_t2v_video",
    description: "Generate a video from a prompt using HappyHorse text-to-video. Creates a new vid- asset and enqueues a background job.",
    schema: generateHappyhorseT2vVideoSchema,
    handler: async (args) => {
      const { project_slug, prompt, resolution, aspect_ratio, duration, seed } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const videoName = `${modelSlug("kie", "happyhorse/text-to-video")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const jobId = `${modelSlug("kie", "happyhorse/text-to-video")}-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_t2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ vid_asset_id: vidAssetId, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

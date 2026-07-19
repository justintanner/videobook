import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  HappyHorse11AspectRatioSchema,
  HappyHorse11TextToVideoRequestSchema,
  HappyHorseDurationSchema,
  HappyHorseResolutionSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";

const SLUG = modelSlug("kie", "happyhorse-1-1/text-to-video");

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
  prompt: apicityStringField(HappyHorse11TextToVideoRequestSchema.shape.input.shape.prompt, "Video description (max 5000 chars / 2500 Chinese chars)", { required: true }),
  resolution: apicityField(HappyHorseResolutionSchema, "Output resolution: 720p / 1080p (default 1080p)"),
  aspect_ratio: apicityField(HappyHorse11AspectRatioSchema, "Output aspect ratio (default 16:9)"),
  duration: apicityStringNumberField(HappyHorseDurationSchema, "Video duration in seconds (3-15, default 5)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseT2vVideoSchema>;

export function generateHappyhorseT2vVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_happyhorse_t2v_video",
    description: "Generate a video from a prompt using HappyHorse text-to-video. Creates a new vid- asset and enqueues a background job.",
    schema: generateHappyhorseT2vVideoSchema,
    handler: async (args) => {
      const { project_slug, prompt, resolution, aspect_ratio, duration } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const videoName = `${SLUG}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const jobId = `${SLUG}-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_t2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
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

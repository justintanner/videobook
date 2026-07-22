import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  GrokImagineModeSchema,
  GrokImagineResolutionSchema,
  GrokTextToVideoRequestSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const grokT2vInputSchema = GrokTextToVideoRequestSchema.shape.input.shape;

const generateGrokImagineT2vVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(grokT2vInputSchema.prompt, "Video description (max 5000 chars)", { required: true }),
  mode: apicityField(GrokImagineModeSchema, "Generation mode: fun / normal / spicy"),
  duration: apicityField(grokT2vInputSchema.duration, "Video duration in seconds (6-30)"),
  resolution: apicityField(GrokImagineResolutionSchema, "Output resolution: 480p / 720p"),
  aspect_ratio: apicityField(grokT2vInputSchema.aspect_ratio, "Output aspect ratio"),
  nsfw_checker: apicityField(grokT2vInputSchema.nsfw_checker, "Enable NSFW content safety filter (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineT2vVideoSchema>;

export function generateGrokImagineT2vVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_kie_grok_imagine_text_to_video",
    description: "Generate a video from a text prompt using Grok Imagine text-to-video (no images). Creates a new vid- asset and enqueues a background job.",
    schema: generateGrokImagineT2vVideoSchema,
    handler: async (args) => {
      const { project_slug, prompt, mode, duration, resolution, aspect_ratio, nsfw_checker } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const videoName = `${modelSlug("kie", "grok-imagine/text-to-video")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine/text-to-video")}-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_t2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

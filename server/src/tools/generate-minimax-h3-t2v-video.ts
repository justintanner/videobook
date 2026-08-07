import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import {
  MiniMaxH3DurationSchema,
  MiniMaxH3FixedAspectRatioSchema,
  MiniMaxH3ResolutionSchema,
  MiniMaxH3TextToVideoRequestSchema,
} from "@apicity/kie/zod";
import { modelSlug } from "@apicity/cost";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const SLUG = modelSlug("kie", "minimax-h3/text-to-video");

const generateMiniMaxH3T2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(MiniMaxH3TextToVideoRequestSchema.shape.input.shape.prompt, "Video description (max 7000 chars)", { required: true }),
  aspect_ratio: apicityField(MiniMaxH3FixedAspectRatioSchema, "Output aspect ratio (required): 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16", { required: true }),
  duration: apicityStringNumberField(MiniMaxH3DurationSchema, "Video duration: 4-15 seconds (required)", { required: true }),
  resolution: apicityField(MiniMaxH3ResolutionSchema, "Output resolution: 768P / 2K (default 768P)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateMiniMaxH3T2vVideoSchema>;

export function generateMiniMaxH3T2vVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_minimax_h3_text_to_video",
    description: "Generate a video from a prompt using MiniMax H3 text-to-video. Creates a new video artifact and enqueues a background job.",
    schema: generateMiniMaxH3T2vVideoSchema,
    handler: async (args) => {
      const { book_id, prompt, aspect_ratio, duration, resolution } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const videoName = generationLabel(SLUG, prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const jobId = `${SLUG}-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_minimax_h3_t2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        aspect_ratio,
        duration,
        ...(resolution !== undefined ? { resolution } : {}),
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

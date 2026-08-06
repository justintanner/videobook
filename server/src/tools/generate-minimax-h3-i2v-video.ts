import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import {
  MiniMaxH3DurationSchema,
  MiniMaxH3ImageToVideoRequestSchema,
  MiniMaxH3ResolutionSchema,
} from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";
import { resolveImageRef, type RefInput } from "./_seedance2-shared.js";

// Literal label: @apicity/cost has no minimax-h3 slug or pricing yet, so
// modelSlug() would throw at module scope (docs/apicity-gaps.md §35).
const SLUG = "minimax-h3-i2v";

const generateMiniMaxH3I2vVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(MiniMaxH3ImageToVideoRequestSchema.shape.input.shape.prompt, "Video description (max 7000 chars)", { required: true }),
  first_frame_ref: z.string().optional().describe("First frame image asset (at least one of first/last frame required, e.g., @img-start)"),
  last_frame_ref: z.string().optional().describe("Last frame image asset (at least one of first/last frame required, e.g., @img-end)"),
  duration: apicityStringNumberField(MiniMaxH3DurationSchema, "Video duration: 4-15 seconds (required)", { required: true }),
  resolution: apicityField(MiniMaxH3ResolutionSchema, "Output resolution: 768P / 2K (default 768P)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateMiniMaxH3I2vVideoSchema>;

export function generateMiniMaxH3I2vVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_minimax_h3_image_to_video",
    description: "Generate a video from a first and/or last frame image using MiniMax H3 image-to-video. Creates a new video artifact and enqueues a background job.",
    schema: generateMiniMaxH3I2vVideoSchema,
    handler: async (args) => {
      const { book_id, prompt, first_frame_ref, last_frame_ref, duration, resolution } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      let firstFrame: RefInput | undefined;
      if (first_frame_ref !== undefined && first_frame_ref.trim() !== "") {
        const r = await resolveImageRef(fs, first_frame_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let lastFrame: RefInput | undefined;
      if (last_frame_ref !== undefined && last_frame_ref.trim() !== "") {
        const r = await resolveImageRef(fs, last_frame_ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        lastFrame = r.value;
      }

      if (!firstFrame && !lastFrame) {
        return { isError: true as const, content: [{ type: "text" as const, text: "At least one of first_frame_ref or last_frame_ref is required" }] };
      }

      const videoName = generationLabel(SLUG, prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds: string[] = [];
      if (firstFrame) sourceImageIds.push(firstFrame.assetId);
      if (lastFrame && lastFrame.assetId !== firstFrame?.assetId) sourceImageIds.push(lastFrame.assetId);
      const jobId = `${SLUG}-i2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_minimax_h3_i2v_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        duration,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        sourceImageIds,
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: sourceImageIds, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

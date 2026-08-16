import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7ImageToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const base = FalWanV2p7ImageToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Video description", { required: true }),
  first_frame_ref: apicityStringField(base.image_url, "First frame image artifact id", { required: true }),
  end_frame_ref: apicityStringField(base.end_image_url, "Optional end frame image asset"),
  resolution: apicityField(base.resolution, "Output resolution"),
  duration: apicityField(base.duration, "Video duration in seconds (2-15)"),
  negative_prompt: apicityStringField(base.negative_prompt, "Things to avoid"),
  enable_prompt_expansion: apicityField(base.enable_prompt_expansion, "Enable prompt expansion"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27I2vFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_wan_2_7_image_to_video",
    description: "Generate a video via fal.ai using Alibaba Wan v2.7 from a first-frame image (optional end frame). Creates a new video artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, first_frame_ref, end_frame_ref, resolution, duration, negative_prompt, enable_prompt_expansion, enable_safety_checker, seed } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const slugs = end_frame_ref ? [first_frame_ref, end_frame_ref] : [first_frame_ref];
      const resolved = await resolveImageRefs(fs, slugs);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const [firstFrame, endFrame] = resolved.inputs;
      const assetResult = await fs.artifacts.create("vid", generationLabel(modelSlug("kie", "wan/2-7-image-to-video"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-image-to-video")}-i2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_i2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        firstFrame,
        ...(endFrame ? { endFrame } : {}),
        sourceImageIds: resolved.sourceImageIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(enable_prompt_expansion !== undefined ? { enable_prompt_expansion } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

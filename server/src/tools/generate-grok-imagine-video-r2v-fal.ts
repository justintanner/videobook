import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineVideoReferenceToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const base = FalXaiGrokImagineVideoReferenceToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Video description", { required: true }),
  image_slugs: apicityStringArrayField(base.reference_image_urls, "1-7 reference image @slugs", { required: true }).min(1),
  duration: apicityField(base.duration, "Video duration in seconds (1-10)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution (480p / 720p)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineVideoR2vFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_grok_imagine_video_reference_to_video",
    description: "Generate a video via fal.ai using xAI Grok Imagine Video reference-to-video guided by 1-7 reference images. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, image_slugs, duration, aspect_ratio, resolution } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const resolved = await resolveImageSlugs(fs, image_slugs, book_id);
      if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };

      const assetResult = await fs.artifacts.create("vid", `${modelSlug("kie", "grok-imagine/image-to-video")}-${slugify(prompt) || String(Date.now())}`);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/image-to-video")}-r2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video_r2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolved.inputs,
        sourceImageIds: resolved.sourceImageIds,
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolved.sourceImageIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}

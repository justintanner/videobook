import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { KlingV3TurboImageToVideoRequestSchema, KlingV3TurboTextToVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { resolveImageRef, slugify, type RefInput } from "./_seedance2-shared.js";
import { modelSlug } from "@apicity/cost";

const klingTurboI2v = KlingV3TurboImageToVideoRequestSchema.shape.input.shape;
const klingTurboT2v = KlingV3TurboTextToVideoRequestSchema.shape.input.shape;

const generateKling30TurboVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(klingTurboT2v.prompt, "Video description", { required: true }),
  image_refs: apicityStringArrayField(klingTurboI2v.image_urls, "0-1 reference image artifact ids (optional)"),
  duration: apicityField(klingTurboT2v.duration, "Video duration: 3s-15s (default '5')"),
  resolution: apicityField(klingTurboT2v.resolution, "Video resolution: 720p / 1080p"),
  aspect_ratio: apicityField(klingTurboT2v.aspect_ratio, "Video aspect ratio (only for text-to-video)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30TurboVideoSchema>;

export function generateKling30TurboVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_kling_3_0_turbo_video",
    description: "Generate a video using Kling 3.0 Turbo tier via KIE (text-to-video or image-to-video). Creates a new video artifact and enqueues a background job.",
    schema: generateKling30TurboVideoSchema,
    handler: async (args) => {
      const { book_id, prompt, image_refs, duration, resolution, aspect_ratio } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const dropBlanks = (xs: string[] | undefined): string[] => (xs ?? []).filter((s) => !blank(s));
      const imgs = dropBlanks(image_refs);

      const imageInputs: RefInput[] = [];
      for (const slug of imgs) {
        const r = await resolveImageRef(fs, slug, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `image_refs: ${r.error}` }] };
        imageInputs.push(r.value);
      }

      const isI2V = imageInputs.length > 0;
      const model = isI2V ? "kling/v3-turbo-image-to-video" : "kling/v3-turbo-text-to-video";

      const videoName = `${modelSlug("kie", model)}-${slugify(prompt) || Date.now().toString(36)}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `kie-${modelSlug("kie", model)}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_kling30_turbo_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        imageInputs,
        sourceImageIds,
        prompt,
        model,
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(!isI2V && aspect_ratio !== undefined ? { aspect_ratio } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

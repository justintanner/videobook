import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { modelSlug } from "@apicity/cost";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs } from "./_image-inputs.js";
import { slugify } from "./_seedance2-shared.js";

// Allowed values are hand-typed from the useapi.net Google Flow docs — the
// 0.7.2 @apicity/googleflow images.aspectRatio enum mixes ratio + keyword forms
// and images.model stays loose, so the app pins its own set (docs/apicity-gaps.md §14).
// "auto" derives the ratio from the reference images, so it is only valid
// when references are supplied.
const NBP_GOOGLE_ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "auto"] as const;

const generateNanoBananaProGoogleSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Image description"),
  image_slugs: z.array(z.string()).max(10).optional().describe("Reference image @slugs or http(s) URLs (0-10, e.g., @img-style)"),
  aspect_ratio: z.enum(NBP_GOOGLE_ASPECT_RATIOS).optional().describe("Output aspect ratio ('auto' only with reference images; default 16:9)"),
  seed: z.number().int().min(0).optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'google')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateNanoBananaProGoogleSchema>;

export function generateNanoBananaProGoogleDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_nano_banana_pro_google",
    description: "Generate an image using Google Nano Banana Pro via Google Flow. Text-to-image or image-to-image from up to 10 reference images. Creates a new img- asset and enqueues a background job.",
    schema: generateNanoBananaProGoogleSchema,
    handler: async (args) => {
      const raw = args as Args;
      const { project_slug, prompt, image_slugs, aspect_ratio, seed } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";

      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "GOOGLE_FLOW_API_KEY environment variable is not set" }] };
      }

      const rawSlugs = (image_slugs ?? []).filter((s) => !blank(s));
      if (aspect_ratio === "auto" && rawSlugs.length === 0) {
        return { isError: true as const, content: [{ type: "text" as const, text: "aspect_ratio 'auto' requires at least one reference image" }] };
      }

      const resolution = await resolveImageSlugs(fs, rawSlugs, project_slug);
      if (!resolution.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: resolution.error }] };
      }
      const { inputs: imageInputs, sourceImageIds } = resolution;

      // The kie slug ("nbp") keeps asset names consistent across providers of
      // the same model; @apicity/cost has no google slugs (gaps §15).
      const nameSlug = modelSlug("kie", "nano-banana-pro");
      const imageName = `${nameSlug}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("img", imageName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }] };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;
      const jobId = `google-${nameSlug}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_nano_banana_pro_google",
        imgAssetId,
        imgAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs,
        sourceImageIds,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

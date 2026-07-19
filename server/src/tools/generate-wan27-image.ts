import { modelSlug } from "@apicity/cost";
import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageInputSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
const wan27ImageInput = Wan27ImageInputSchema.shape;

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateWan27ImageSchema = {
  prompt: apicityStringField(wan27ImageInput.prompt, "Text prompt for image generation (max 5000 chars)", { required: true }),
  project_slug: z.string().describe("Project slug"),
  image_slugs: apicityStringArrayField(wan27ImageInput.input_urls, "0-9 @img-* slugs for reference images"),
  aspect_ratio: apicityField(wan27ImageInput.aspect_ratio, "Output aspect ratio (default 16:9)"),
  resolution: apicityField(wan27ImageInput.resolution, "Output resolution (default 2K)"),
  seed: apicityField(wan27ImageInput.seed, "Random seed (0-2147483647)"),
  nsfw_checker: apicityField(wan27ImageInput.nsfw_checker, "Content safety filter (default false)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27ImageSchema>;

export function generateWan27ImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_wan27_image",
    description: "Generate an image using Wan 2.7 Image. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional (0-9).",
    schema: generateWan27ImageSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, seed, nsfw_checker } = args as Args;

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imageInputs: Array<{ assetId: string; filename: string }> = [];
      const sourceImageIds: string[] = [];

      if (ids.length > 0) {
        if (ids.length > 9) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "Maximum 9 reference images allowed" }],
          };
        }

        for (const id of ids) {
          if (!id.startsWith("img-")) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${id}` }],
            };
          }

          const manifestResult = await fs.getManifest(id, project_slug);
          if (!manifestResult.ok) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: manifestResult.error.message }],
            };
          }

          const manifest = manifestResult.value;
          const imageFile = findImageFile(manifest.files);
          if (!imageFile) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `No image file found in asset ${id}` }],
            };
          }

          imageInputs.push({ assetId: id, filename: imageFile.name });
          sourceImageIds.push(id);
        }
      }

      const assetName = `${modelSlug("kie", "wan/2-7-image")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("img", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "wan/2-7-image")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(nsfw_checker !== undefined ? { nsfwChecker: nsfw_checker } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

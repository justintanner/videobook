import { modelSlug } from "@apicity/cost";
import type { VideocityFs, AssetManifestFile } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { GrokImageToImageRequestSchema } from "@apicity/kie/zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { requireAtLeastOne, toolError } from "./_shared.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function deriveImageName(imageAssetId: string): string {
  const baseName = imageAssetId.startsWith("img-") ? imageAssetId.slice(4) : imageAssetId;
  return `grok-${baseName}`;
}

const generateGrokImagineImageSchema = {
  asset_id: z.string().optional().describe("Image asset ID (must be img-*)"),
  image_slugs: apicityStringArrayField(GrokImageToImageRequestSchema.shape.input.shape.image_urls, "Exactly one image slug (e.g., ['@img-sunset']). Used as fallback when asset_id is not provided."),
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(GrokImageToImageRequestSchema.shape.input.shape.prompt, "Optional prompt to guide image transformation"),
  nsfw_checker: apicityField(GrokImageToImageRequestSchema.shape.input.shape.nsfw_checker, "Enable NSFW content safety filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineImageSchema>;

export function generateGrokImagineImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_kie_grok_imagine_image_to_image",
    description: "Generate an image from an image asset using Grok Imagine image-to-image. Creates a new img- asset and enqueues a background job. Requires at least one of asset_id or image_slugs.",
    schema: generateGrokImagineImageSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_slugs, project_slug, prompt, _provider } = args as Args;

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return toolError(`${requiredKey} environment variable is not set`);
      }

      const missingInput = requireAtLeastOne("generate_kie_grok_imagine_image_to_image", [
        { name: "asset_id", value: rawAssetId },
        { name: "image_slugs", value: image_slugs },
      ]);
      if (missingInput) return missingInput;

      // Derive asset_id from image_slugs if not provided directly
      const asset_id = rawAssetId ?? (image_slugs?.[0]?.replace(/^@/, "") || undefined);
      if (!asset_id) {
        return toolError("asset_id or image_slugs with at least one entry is required");
      }

      if (!asset_id.startsWith("img-")) {
        return toolError(`asset_id must start with img-, got: ${asset_id}`);
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return toolError(manifestResult.error.message);
      }

      const manifest = manifestResult.value;
      const imageFile = findImageFile(manifest.files);
      if (!imageFile) {
        return toolError(`No image file found in asset ${asset_id}`);
      }

      const imagePath = join(manifest.path, imageFile.name);
      const imgName = deriveImageName(asset_id);
      const assetResult = await fs.createAsset("img", imgName, project_slug);
      if (!assetResult.ok) {
        return toolError(`Failed to create image asset: ${assetResult.error.message}`);
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine/text-to-image")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_image",
        imagePath,
        imageFilename: imageFile.name,
        imgAssetId,
        imgAssetDir,
        sourceImageId: asset_id,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(_provider !== undefined ? { _provider } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            source_image: asset_id,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

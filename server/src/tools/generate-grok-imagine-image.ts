import { modelSlug } from "@apicity/cost";
import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

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
  image_slugs: z.array(z.string()).optional().describe("Image slugs (e.g., ['@img-sunset']). Used as fallback when asset_id is not provided."),
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Optional prompt to guide image transformation"),
  aspect_ratio: z.string().optional().describe("Aspect ratio"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineImageSchema>;

export function generateGrokImagineImageDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_grok_imagine_image",
    description: "Generate an image from an image asset using Grok Imagine image-to-image. Creates a new img- asset and enqueues a background job.",
    schema: generateGrokImagineImageSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_slugs, project_slug, prompt, aspect_ratio, _provider } = args as Args;

      // Derive asset_id from image_slugs if not provided directly
      const asset_id = rawAssetId ?? (image_slugs?.[0]?.replace(/^@/, "") || undefined);

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `${requiredKey} environment variable is not set` }],
        };
      }

      if (!asset_id) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "asset_id or image_slugs with at least one entry is required" }],
        };
      }

      if (!asset_id.startsWith("img-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must start with img-, got: ${asset_id}` }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
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
          content: [{ type: "text" as const, text: `No image file found in asset ${asset_id}` }],
        };
      }

      const imagePath = join(manifest.path, imageFile.name);
      const imgName = deriveImageName(asset_id);
      const assetResult = await fs.createAsset("img", imgName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
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
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
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


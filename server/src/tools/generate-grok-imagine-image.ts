import { modelSlug } from "@apicity/cost";
import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { GrokImageToImageRequestSchema } from "@apicity/kie/zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { requireAtLeastOne, toolError } from "./_shared.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function deriveImageName(imageAssetId: string): string {
  return `grok-${imageAssetId}`;
}

const generateGrokImagineImageSchema = {
  asset_id: z.string().optional().describe("Image artifact id"),
  image_refs: apicityStringArrayField(GrokImageToImageRequestSchema.shape.input.shape.image_urls, "Exactly one image artifact id. Used as fallback when asset_id is not provided."),
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(GrokImageToImageRequestSchema.shape.input.shape.prompt, "Optional prompt to guide image transformation"),
  nsfw_checker: apicityField(GrokImageToImageRequestSchema.shape.input.shape.nsfw_checker, "Enable NSFW content safety filter"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineImageSchema>;

export function generateGrokImagineImageDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_grok_imagine_image_to_image",
    description: "Generate an image from an image asset using Grok Imagine image-to-image. Creates a new image artifact and enqueues a background job. Requires at least one of asset_id or image_refs.",
    schema: generateGrokImagineImageSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_refs, book_id, prompt, _provider } = args as Args;

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return toolError(`${requiredKey} environment variable is not set`);
      }

      const missingInput = requireAtLeastOne("generate_kie_grok_imagine_image_to_image", [
        { name: "asset_id", value: rawAssetId },
        { name: "image_refs", value: image_refs },
      ]);
      if (missingInput) return missingInput;

      // Derive asset_id from image_refs if not provided directly
      const asset_id = rawAssetId ?? (image_refs?.[0]?.replace(/^@/, "") || undefined);
      if (!asset_id) {
        return toolError("asset_id or image_refs with at least one entry is required");
      }

      const sourceArtifact = fs.artifacts.get(asset_id);
      if (!sourceArtifact.ok) return toolError(sourceArtifact.error.message);
      if (sourceArtifact.value.kind !== "image") {
        return toolError(`asset_id must be an image artifact, got ${sourceArtifact.value.kind}: ${asset_id}`);
      }

      const manifestResult = await fs.files.manifest(asset_id);
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
      const assetResult = await fs.artifacts.create("img", imgName);
      if (!assetResult.ok) {
        return toolError(`Failed to create image asset: ${assetResult.error.message}`);
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine/text-to-image")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_image",
        imagePath,
        imageFilename: imageFile.name,
        imgAssetId,
        imgAssetDir,
        sourceImageId: asset_id,
        bookId: book_id,
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

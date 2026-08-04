import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  AlibabaImageGenerationParametersSchema,
  AlibabaImageReferenceSlotsSchema,
  AlibabaImageTextContentSchema,
} from "@apicity/alibaba/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

const generateAlibabaImageSchema = {
  prompt: apicityStringField(AlibabaImageTextContentSchema.shape.text, "Text prompt for image generation (max 5000 chars)", { required: true }),
  book_id: z.string().describe("Book id"),
  image_refs: apicityStringArrayField(AlibabaImageReferenceSlotsSchema, "0-9 image artifact ids for reference images"),
  size: apicityStringField(AlibabaImageGenerationParametersSchema.shape.size, "Output size (e.g., '1024*1024', '720*1280', '1280*720')"),
  n: apicityField(AlibabaImageGenerationParametersSchema.shape.n, "Number of images to generate (1-12)"),
  watermark: apicityField(AlibabaImageGenerationParametersSchema.shape.watermark, "Add watermark to generated image"),
  thinking_mode: apicityField(AlibabaImageGenerationParametersSchema.shape.thinking_mode, "Enable thinking mode for better quality"),
  seed: apicityField(AlibabaImageGenerationParametersSchema.shape.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaImageSchema>;

export function generateAlibabaImageDef(fs: Engine): ToolDef {
  return {
    name: "generate_alibaba_wan_2_7_text_to_image",
    description: "Generate an image using Alibaba Cloud Wan 2.7 Image. Creates a new image artifact and enqueues a background job. Prompt is required; reference images are optional (0-9).",
    schema: generateAlibabaImageSchema,
    handler: async (args) => {
      const { prompt, book_id, image_refs, size, n, watermark, thinking_mode, seed } = args as Args;

      const ids = (image_refs ?? []).map((s) => s.replace(/^@/, ""));

      if (!process.env.DASHSCOPE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "DASHSCOPE_API_KEY environment variable is not set" }],
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
          const artifact = fs.artifacts.get(id);
          if (!artifact.ok) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: artifact.error.message }],
            };
          }
          if (artifact.value.kind !== "image") {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `image_refs entries must be image artifacts, got ${artifact.value.kind}: ${id}` }],
            };
          }

          const manifestResult = await fs.files.manifest(id);
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

      const assetName = generationLabel(modelSlug("alibaba", "wan2.7-image"), prompt);
      const assetResult = await fs.artifacts.create("img", assetName);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { artifactId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `alibaba-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        bookId: book_id,
        model: "wan2.7-image",
        ...(size !== undefined ? { size } : {}),
        ...(n !== undefined ? { n } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(thinking_mode !== undefined ? { thinkingMode: thinking_mode } : {}),
        ...(seed !== undefined ? { seed } : {}),
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

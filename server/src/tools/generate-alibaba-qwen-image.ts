import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  AlibabaMultimodalGenerationParametersSchema,
  AlibabaImageTextContentSchema,
  AlibabaQwenImageGenerationImageSlotsSchema,
  AlibabaQwenImageGenerationStableModelSchema,
} from "@apicity/alibaba/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateAlibabaQwenImageSchema = {
  prompt: apicityStringField(AlibabaImageTextContentSchema.shape.text, "Text prompt for image generation", { required: true }),
  project_slug: z.string().describe("Project slug"),
  image_slugs: apicityStringArrayField(AlibabaQwenImageGenerationImageSlotsSchema, "0-3 @img-* slugs for reference images"),
  model: apicityField(AlibabaQwenImageGenerationStableModelSchema, "Qwen generation model", { required: true }),
  size: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.size, "Output size (e.g., '1024*1024')"),
  n: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.n, "Number of images to generate (1-6)"),
  negative_prompt: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.negative_prompt, "Negative prompt (max 500 chars)"),
  prompt_extend: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.prompt_extend, "Let the model expand the prompt"),
  watermark: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.watermark, "Add watermark to generated image"),
  seed: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaQwenImageSchema>;

export function generateAlibabaQwenImageDef(fs: Engine): ToolDef {
  return {
    name: "generate_alibaba_qwen_2_0_text_to_image",
    description: "Generate an image using Alibaba Cloud Qwen (qwen-image-2.0 family) via the synchronous multimodal endpoint. Creates a new img- asset. Prompt is required; 0-3 optional reference images.",
    schema: generateAlibabaQwenImageSchema,
    handler: async (args) => {
      const {
        prompt, project_slug, image_slugs, model, size, n,
        negative_prompt, prompt_extend, watermark, seed,
      } = args as Args;

      if (!process.env.DASHSCOPE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "DASHSCOPE_API_KEY environment variable is not set" }],
        };
      }

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));
      if (ids.length > 3) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Qwen image generation supports at most 3 reference images" }],
        };
      }

      const imageInputs: Array<{ assetId: string; filename: string }> = [];
      const sourceImageIds: string[] = [];

      for (const id of ids) {
        if (!id.startsWith("img-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${id}` }],
          };
        }
        const manifestResult = await fs.files.manifest(id, project_slug);
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: manifestResult.error.message }],
          };
        }
        const imageFile = findImageFile(manifestResult.value.files);
        if (!imageFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `No image file found in asset ${id}` }],
          };
        }
        imageInputs.push({ assetId: id, filename: imageFile.name });
        sourceImageIds.push(id);
      }

      const resolvedModel = AlibabaQwenImageGenerationStableModelSchema.parse(model);

      const assetResult = await fs.artifacts.create("img", `${modelSlug("alibaba", resolvedModel)}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { slug: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `alibaba-${modelSlug("alibaba", resolvedModel)}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_qwen_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        model: resolvedModel,
        ...(size !== undefined ? { size } : {}),
        ...(n !== undefined ? { n } : {}),
        ...(negative_prompt !== undefined ? { negativePrompt: negative_prompt } : {}),
        ...(prompt_extend !== undefined ? { promptExtend: prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
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

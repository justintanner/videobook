import type { VideocityFs, AssetManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  AlibabaMultimodalGenerationParametersSchema,
  AlibabaImageTextContentSchema,
  AlibabaQwenImageEditImageSlotsSchema,
  AlibabaQwenImageEditStableModelSchema,
} from "@apicity/alibaba/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateAlibabaQwenImageEditSchema = {
  prompt: apicityStringField(AlibabaImageTextContentSchema.shape.text, "Edit instruction text", { required: true }),
  project_slug: z.string().describe("Project slug"),
  image_slugs: apicityStringArrayField(AlibabaQwenImageEditImageSlotsSchema, "1-3 @img-* slugs for source images (required)", { required: true }),
  model: apicityField(AlibabaQwenImageEditStableModelSchema, "Qwen edit model", { required: true }),
  size: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.size, "Output size. Not allowed when model is 'qwen-image-edit'"),
  n: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.n, "Number of images (1-6). 'qwen-image-edit' supports only n=1"),
  negative_prompt: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.negative_prompt, "Negative prompt (max 500 chars)"),
  prompt_extend: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.prompt_extend, "Let the model expand the prompt. Not allowed when model is 'qwen-image-edit'"),
  watermark: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.watermark, "Add watermark to generated image"),
  seed: apicityField(AlibabaMultimodalGenerationParametersSchema.shape.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaQwenImageEditSchema>;

export function generateAlibabaQwenImageEditDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_alibaba_qwen_2_0_edit_image",
    description: "Edit an image using Alibaba Cloud Qwen (qwen-image-edit family) via the synchronous multimodal endpoint. Requires 1-3 reference images and an instruction prompt.",
    schema: generateAlibabaQwenImageEditSchema,
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

      const ids = image_slugs.map((s) => s.replace(/^@/, ""));
      if (ids.length < 1 || ids.length > 3) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Qwen image edit requires 1-3 reference images" }],
        };
      }

      const resolvedModel = AlibabaQwenImageEditStableModelSchema.parse(model);

      if (resolvedModel === "qwen-image-edit") {
        if (n !== undefined && n !== 1) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "qwen-image-edit only supports n=1" }],
          };
        }
        if (size !== undefined) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "qwen-image-edit does not support custom size" }],
          };
        }
        if (prompt_extend !== undefined) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "qwen-image-edit does not support prompt_extend" }],
          };
        }
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
        const manifestResult = await fs.getManifest(id, project_slug);
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

      const assetResult = await fs.createAsset("img", `${modelSlug("alibaba", resolvedModel)}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `alibaba-${modelSlug("alibaba", resolvedModel)}-edit-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_qwen_image_edit",
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

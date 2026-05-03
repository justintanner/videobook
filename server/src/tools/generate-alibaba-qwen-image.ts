import type { ClipfirstFs, AssetManifestFile } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

const QWEN_GENERATION_MODELS = ["qwen-image-2.0-pro", "qwen-image-2.0"] as const;
type QwenGenerationModel = typeof QWEN_GENERATION_MODELS[number];

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

const generateAlibabaQwenImageSchema = {
  prompt: z.string().describe("Text prompt for image generation"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).optional().describe("0-3 @img-* slugs for reference images"),
  model: z.enum(QWEN_GENERATION_MODELS).optional().describe("Qwen generation model (default: qwen-image-2.0-pro)"),
  size: z.string().optional().describe("Output size (e.g., '1024*1024')"),
  n: z.number().int().min(1).max(6).optional().describe("Number of images to generate (1-6)"),
  negative_prompt: z.string().max(500).optional().describe("Negative prompt (max 500 chars)"),
  prompt_extend: z.boolean().optional().describe("Let the model expand the prompt"),
  watermark: z.boolean().optional().describe("Add watermark to generated image"),
  seed: z.number().int().min(0).max(2147483647).optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaQwenImageSchema>;

export function generateAlibabaQwenImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_alibaba_qwen_image",
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

      const resolvedModel: QwenGenerationModel = model ?? "qwen-image-2.0-pro";

      const assetResult = await fs.createAsset("img", `${modelSlug("alibaba", resolvedModel)}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

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

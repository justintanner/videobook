import type { ClipfirstFs, AssetManifestFile } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { extname } from "node:path";
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

const generateAlibabaImageProSchema = {
  prompt: z.string().describe("Text prompt for image generation (max 5000 chars)"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).optional().describe("0-9 @img-* slugs for reference images"),
  size: z.string().optional().describe("Output size (e.g., '1024*1024', '720*1280', '1280*720')"),
  n: z.number().int().min(1).max(12).optional().describe("Number of images to generate (1-12)"),
  watermark: z.boolean().optional().describe("Add watermark to generated image"),
  thinking_mode: z.boolean().optional().describe("Enable thinking mode for better quality"),
  seed: z.number().int().min(0).max(2147483647).optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'alibaba')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateAlibabaImageProSchema>;

export function generateAlibabaImageProDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_alibaba_image_pro",
    description: "Generate a pro image using Alibaba Cloud Wan 2.7 Image Pro. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional (0-9).",
    schema: generateAlibabaImageProSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, size, n, watermark, thinking_mode, seed } = args as Args;

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));

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

      const assetName = `${modelSlug("alibaba", "wan2.7-image-pro")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("img", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      const jobId = `alibaba-${modelSlug("alibaba", "wan2.7-image-pro")}-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_alibaba_image_pro",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        model: "wan2.7-image-pro",
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

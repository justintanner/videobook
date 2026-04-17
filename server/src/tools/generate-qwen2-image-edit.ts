import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z, type ZodRawShape } from "zod";
import { Qwen2ImageEditRequestSchema } from "@apicity/kie/zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";

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
  return `qwen2-${baseName}`;
}

const qwen2ImageEditInputSchema = Qwen2ImageEditRequestSchema.shape.input.shape;

const generateQwen2ImageEditSchema = {
  prompt: z.string().describe("Image editing prompt (max 800 chars)"),
  project_slug: z.string().describe("Project slug"),
  image_slugs: z.array(z.string()).describe("1-3 @img-* slugs for reference images to edit"),
  image_size: z.enum(qwen2ImageEditInputSchema.image_size.unwrap().options).optional().describe("Output aspect ratio (default 16:9)"),
  output_format: z.enum(qwen2ImageEditInputSchema.output_format.unwrap().options).optional().describe("Output image format (default png)"),
  seed: z.number().optional().describe("Random seed"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateQwen2ImageEditSchema>;

export function generateQwen2ImageEditDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_qwen2_image_edit",
    description: "Edit images using Qwen2 image-edit on Kie. Requires 1-3 reference images. Creates a new img- asset and enqueues a background job.",
    schema: generateQwen2ImageEditSchema,
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, image_size, output_format, seed } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));

      // Apicity Qwen2ImageEditRequestSchema enforces image_url .min(1).max(3)
      // and prompt .min(1). Slugs stand in for URLs here — they are non-empty
      // strings that satisfy the inner `z.string().min(1)` constraint. The
      // actual URLs are resolved post-upload in the job handler.
      const apicityCheck = Qwen2ImageEditRequestSchema.safeParse({
        model: "qwen2/image-edit",
        input: {
          prompt,
          image_url: ids,
          ...(image_size !== undefined ? { image_size } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const invalidIds = ids.filter((id) => !id.startsWith("img-"));
      if (invalidIds.length > 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${invalidIds.join(", ")}` }],
        };
      }

      const sourceImageIds: string[] = [];
      const imagePaths: string[] = [];
      const imageFilenames: string[] = [];

      for (const sourceImageId of ids) {
        const manifestResult = await fs.getManifest(sourceImageId, project_slug);
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
            content: [{ type: "text" as const, text: `No image file found in asset ${sourceImageId}` }],
          };
        }

        sourceImageIds.push(sourceImageId);
        imagePaths.push(join(manifest.path, imageFile.name));
        imageFilenames.push(imageFile.name);
      }

      const imgName = deriveImageName(sourceImageIds[0]!);
      const assetResult = await fs.createAsset("img", imgName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "qwen2_image_edit",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: {
          sourceImageIds,
          prompt,
          ...(image_size !== undefined ? { imageSize: image_size } : {}),
          ...(output_format !== undefined ? { outputFormat: output_format } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
      });

      const jobId = `qwen2-image-edit-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_qwen2_image_edit",
        prompt,
        imagePaths,
        imageFilenames,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(image_size !== undefined ? { imageSize: image_size } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
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

export function registerGenerateQwen2ImageEditTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateQwen2ImageEditDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

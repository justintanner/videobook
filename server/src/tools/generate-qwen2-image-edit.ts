import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { ToolDef } from "./tool-def.js";

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

export function generateQwen2ImageEditDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_qwen2_image_edit",
    description: "Edit an image using Qwen2 image-edit on Kie. Requires exactly 1 reference image. Creates a new img- asset and enqueues a background job.",
    schema: {
      prompt: z.string().describe("Image editing prompt (max 800 chars)"),
      project_slug: z.string().describe("Project slug"),
      image_slugs: z.array(z.string()).describe("Exactly 1 @img-* slug for the reference image to edit"),
      image_size: z.enum(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]).optional().describe("Output aspect ratio (default 16:9)"),
      output_format: z.enum(["png", "jpeg"]).optional().describe("Output image format (default png)"),
      seed: z.number().optional().describe("Random seed"),
      _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
    },
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, image_size, output_format, seed } = args as {
        prompt: string;
        project_slug: string;
        image_slugs: string[];
        image_size?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9";
        output_format?: "png" | "jpeg";
        seed?: number;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));
      if (ids.length !== 1) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Qwen2 image edit requires exactly 1 reference image" }],
        };
      }

      const sourceImageId = ids[0];
      if (!sourceImageId.startsWith("img-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${sourceImageId}` }],
        };
      }

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

      const imagePath = join(manifest.path, imageFile.name);
      const imgName = deriveImageName(sourceImageId);
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
          sourceImageId,
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
        imagePath,
        imageFilename: imageFile.name,
        imgAssetId,
        imgAssetDir,
        sourceImageId,
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
            source_image: sourceImageId,
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

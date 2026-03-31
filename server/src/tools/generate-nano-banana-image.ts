import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { extname } from "node:path";
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

export function generateNanoBananaImageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_nano_banana_image",
    description: "Generate an image using the nano-banana-pro model. Creates a new img- asset and enqueues a background job. Prompt is required; reference images are optional.",
    schema: {
      prompt: z.string().describe("Text prompt for image generation"),
      project_slug: z.string().describe("Project slug"),
      image_slugs: z.array(z.string()).optional().describe("0-8 @img-* slugs for reference images"),
      aspect_ratio: z.enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"]).optional().describe("Aspect ratio"),
      resolution: z.enum(["1K", "2K", "4K"]).optional().describe("Output resolution"),
      output_format: z.enum(["png", "jpg"]).optional().describe("Output image format"),
      _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
    },
    handler: async (args) => {
      const { prompt, project_slug, image_slugs, aspect_ratio, resolution, output_format } = args as {
        prompt: string;
        project_slug: string;
        image_slugs?: string[];
        aspect_ratio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9" | "auto";
        resolution?: "1K" | "2K" | "4K";
        output_format?: "png" | "jpg";
      };

      const ids = (image_slugs ?? []).map((s) => s.replace(/^@/, ""));

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const imageInputs: Array<{ assetId: string; filename: string }> = [];
      const sourceImageIds: string[] = [];

      if (ids.length > 0) {
        if (ids.length > 8) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "Maximum 8 reference images allowed" }],
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

      const assetName = slugify(prompt);
      const assetResult = await fs.createAsset("img", assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create image asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: imgAssetId, path: imgAssetDir } = assetResult.value;

      await writePendingTask(fs, imgAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "nano_banana_image",
        assetId: imgAssetId,
        assetDir: imgAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { sourceImageIds, prompt },
      });

      const jobId = `nano-banana-image-${imgAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_nano_banana_image",
        prompt,
        imageInputs,
        imgAssetId,
        imgAssetDir,
        sourceImageIds,
        projectSlug: project_slug,
        ...(aspect_ratio !== undefined ? { aspectRatio: aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(output_format !== undefined ? { outputFormat: output_format } : {}),
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

export function registerGenerateNanoBananaImageTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateNanoBananaImageDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

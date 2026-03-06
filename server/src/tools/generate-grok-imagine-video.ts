import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function deriveVideoName(imageAssetId: string): string {
  const baseName = imageAssetId.startsWith("img-") ? imageAssetId.slice(4) : imageAssetId;
  return `grok-${baseName}`;
}

export function generateGrokImagineVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_grok_imagine_video",
    description: "Generate a video from an image asset using Grok Imagine image-to-video. Creates a new vid- asset and enqueues a background job.",
    schema: {
      asset_id: z.string().describe("Image asset ID (must be img-*)"),
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().optional().describe("Optional prompt to guide video generation"),
      mode: z.enum(["fun", "normal", "spicy"]).optional().describe("Generation mode"),
      duration: z.enum(["6", "10", "15"]).optional().describe("Video duration in seconds"),
      resolution: z.enum(["480p", "720p"]).optional().describe("Output resolution"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, prompt, mode, duration, resolution } = args as {
        asset_id: string;
        project_slug: string;
        prompt?: string;
        mode?: "fun" | "normal" | "spicy";
        duration?: "6" | "10" | "15";
        resolution?: "480p" | "720p";
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
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
      const videoName = deriveVideoName(asset_id);
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      await mkdir(vidAssetDir, { recursive: true });

      const jobId = `grok-imagine-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video",
        imagePath,
        imageFilename: imageFile.name,
        vidAssetId,
        vidAssetDir,
        sourceImageId: asset_id,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_image: asset_id,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

export function registerGenerateGrokImagineVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generateGrokImagineVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

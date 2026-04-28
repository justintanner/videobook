import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import * as path from "node:path";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const extensionToPrefix: Record<string, string> = {
  ".mp4": "vid",
  ".mov": "vid",
  ".webm": "vid",
  ".avi": "vid",
  ".mkv": "vid",
  ".jpg": "img",
  ".jpeg": "img",
  ".png": "img",
  ".gif": "img",
  ".webp": "img",
  ".svg": "img",
  ".mp3": "aud",
  ".wav": "aud",
  ".aac": "aud",
  ".flac": "aud",
  ".ogg": "aud",
  ".md": "script",
};

export function uploadFileDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "upload_file",
    description: "Upload a media or markdown file into a clipfirst project as an asset",
    schema: {
      project_slug: z.string().describe("Project slug to upload into"),
      filename: z.string().describe("Original filename with extension"),
      data: z.string().describe("Base64-encoded file contents"),
    },
    handler: async (args) => {
      const { project_slug, filename, data } = args as { project_slug: string; filename: string; data: string };
      const ext = path.extname(filename).toLowerCase();
      const prefix = extensionToPrefix[ext];
      if (!prefix) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Unsupported file extension: ${ext}` }],
        };
      }

      const assetName = path.basename(filename, ext);
      const assetResult = await fs.createAsset(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: assetResult.error.message }],
        };
      }

      const { assetId, path: assetPath } = assetResult.value;
      const writtenFilename = `original${ext}`;
      const writeResult = await fs.writeFile(
        assetId,
        writtenFilename,
        Buffer.from(data, "base64"),
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: writeResult.error.message }],
        };
      }

      const provenance = { origin: "upload", processed_at: new Date().toISOString() };
      if (assetId.startsWith("vid-")) {
        const videoPath = path.join(assetPath, writtenFilename);
        const jobId = `process-video-${assetId}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "process_video",
          videoPath,
          assetId,
          assetDir: assetPath,
          projectSlug: project_slug,
          provenance,
        } as unknown as Record<string, unknown>);
      } else if (assetId.startsWith("img-")) {
        const jobId = `process-image-${assetId}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "process_image",
          assetId,
          projectSlug: project_slug,
          extension: ext,
          provenance,
        } as unknown as Record<string, unknown>);
      } else {
        await fs.writeMetadata(assetId, "original", provenance, project_slug);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ assetId, path: assetPath, filename: writtenFilename }),
        }],
      };
    },
  };
}

export function registerUploadFileTool(server: McpServer, fs: ClipfirstFs): void {
  const def = uploadFileDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

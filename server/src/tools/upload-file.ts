import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import * as path from "node:path";

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

export function registerUploadFileTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "upload_file",
    "Upload a media or markdown file into a clipfirst project as an asset",
    {
      project_slug: z.string().describe("Project slug to upload into"),
      filename: z.string().describe("Original filename with extension"),
      data: z.string().describe("Base64-encoded file contents"),
    },
    async ({ project_slug, filename, data }) => {
      const ext = path.extname(filename).toLowerCase();
      const prefix = extensionToPrefix[ext];
      if (!prefix) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unsupported file extension: ${ext}` }],
        };
      }

      const assetName = path.basename(filename, ext);
      const assetResult = await fs.createAsset(prefix, assetName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: assetResult.error.message }],
        };
      }

      const { assetId, path: assetPath } = assetResult.value;
      const writeResult = await fs.writeFile(
        assetId,
        filename,
        Buffer.from(data, "base64"),
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: writeResult.error.message }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ assetId, path: assetPath, filename }),
        }],
      };
    }
  );
}

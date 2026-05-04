import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { uploadLocalBytes } from "../local-upload.js";
import type { ToolDef } from "./tool-def.js";

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
      const result = await uploadLocalBytes(fs, {
        projectSlug: project_slug,
        filename,
        data: Buffer.from(data, "base64"),
        waitForProcessing: true,
      });

      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.message }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result.value),
        }],
      };
    },
  };
}

export function registerUploadFileTool(server: McpServer, fs: ClipfirstFs): void {
  const def = uploadFileDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export const WHITELISTED_AT_FILE = ".whitelisted_at";

export function whitelistAssetDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "whitelist_asset",
    description:
      "Whitelist a video asset for transcription. Videos must be whitelisted before they can be transcribed. New videos start as unreviewed — use this to mark them as ready for the transcription pipeline.",
    schema: {
      asset_id: z.string().describe("Video asset ID (e.g. vid-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as {
        asset_id: string;
        project_slug: string;
      };

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: "Only video assets (vid-*) can be whitelisted",
            },
          ],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: manifestResult.error.message },
          ],
        };
      }

      const alreadyWhitelisted = manifestResult.value.files.some(
        (f) => f.name === WHITELISTED_AT_FILE,
      );

      const timestamp = String(Date.now() / 1000);
      const writeResult = await fs.writeFile(
        asset_id,
        WHITELISTED_AT_FILE,
        timestamp,
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: writeResult.error.message },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              asset_id,
              status: alreadyWhitelisted
                ? "already_whitelisted"
                : "whitelisted",
              whitelisted_at: timestamp,
            }),
          },
        ],
      };
    },
  };
}

export function registerWhitelistAssetTool(
  server: McpServer,
  fs: ClipfirstFs,
): void {
  const def = whitelistAssetDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

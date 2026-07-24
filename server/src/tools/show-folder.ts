import { execFile } from "node:child_process";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function showFolderDef(fs: Engine): ToolDef {
  return {
    name: "show_folder",
    description: "Reveal an asset's folder in Finder",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat)"),
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id } = args as { asset_id: string; book_id: string };
      const result = await fs.workspaces.resolveArtifact(asset_id);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return new Promise((resolve) => {
        execFile("open", ["-R", result.value], (error) => {
          if (error) {
            resolve({
              isError: true as const,
              content: [{ type: "text" as const, text: `Failed to open folder: ${error.message}` }],
            });
          } else {
            resolve({
              content: [{ type: "text" as const, text: JSON.stringify({ status: "opened", path: result.value }) }],
            });
          }
        });
      });
    },
  };
}

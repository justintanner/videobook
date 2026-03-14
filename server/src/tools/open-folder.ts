import { exec } from "node:child_process";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function openFolderDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "open_folder",
    description: "Reveal an asset's folder in Finder",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const result = await fs.resolveAssetDir(asset_id, project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return new Promise((resolve) => {
        exec(`open -R "${result.value}"`, (error) => {
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

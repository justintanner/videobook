import { execFile } from "node:child_process";
import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function showFolderDef(fs: VideocityFs): ToolDef {
  return {
    name: "show_folder",
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

import { exec } from "node:child_process";
import { join } from "node:path";
import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { findPrimaryMediaFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

export function copyFileToClipboardDef(fs: VideocityFs): ToolDef {
  return {
    name: "copy_file_to_clipboard",
    description: "Copy an asset's original media file to the macOS pasteboard as a file reference",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-sunset-drive)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const manifest = manifestResult.value;
      const file = findPrimaryMediaFile(manifest.files, asset_id);
      if (!file) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "No original media file found for asset" }],
        };
      }

      const absPath = join(manifest.path, file.name);
      const fileName = file.name;
      const escaped = absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `set the clipboard to POSIX file "${escaped}"`;

      return new Promise((resolve) => {
        exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error) => {
          if (error) {
            resolve({
              isError: true as const,
              content: [{ type: "text" as const, text: `Failed to copy to clipboard: ${error.message}` }],
            });
          } else {
            resolve({
              content: [{ type: "text" as const, text: JSON.stringify({ status: "copied", path: absPath, file: fileName }) }],
            });
          }
        });
      });
    },
  };
}

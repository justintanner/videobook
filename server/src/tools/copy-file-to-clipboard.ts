import { exec } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function copyFileToClipboardDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "copy_file_to_clipboard",
    description: "Copy an asset's original media file to the macOS pasteboard as a file reference",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-sunset-drive)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };

      const dirResult = await fs.resolveAssetDir(asset_id, project_slug);
      if (!dirResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: dirResult.error.message }],
        };
      }

      const assetDir = dirResult.value;
      let fileName: string | undefined;
      try {
        const files = await readdir(assetDir);
        fileName = files.find((f) => /^original\.(mp4|mov|png|jpe?g|webp|mp3|wav)$/i.test(f));
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to read asset folder: ${(err as Error).message}` }],
        };
      }

      if (!fileName) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "No original media file found for asset" }],
        };
      }

      const absPath = join(assetDir, fileName);
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

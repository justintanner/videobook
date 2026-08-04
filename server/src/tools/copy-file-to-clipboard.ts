import { exec } from "node:child_process";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { findPrimaryMediaFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

export function copyFileToClipboardDef(fs: Engine): ToolDef {
  return {
    name: "copy_file_to_clipboard",
    description: "Copy an asset's original media file to the macOS pasteboard as a file reference",
    schema: {
      asset_id: z.string().describe("Artifact id"),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id } = args as { asset_id: string; book_id: string };

      const artifactResult = fs.artifacts.get(asset_id);
      if (!artifactResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: artifactResult.error.message }],
        };
      }
      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const manifest = manifestResult.value;
      const file = findPrimaryMediaFile(manifest.files, artifactResult.value.kind);
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

import { copyFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { findPrimaryMediaFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";

async function resolveDestination(baseName: string, ext: string): Promise<string> {
  const downloads = join(homedir(), "Downloads");
  let candidate = join(downloads, `${baseName}${ext}`);
  let n = 2;
  while (await fileExists(candidate)) {
    candidate = join(downloads, `${baseName} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function exportToDownloadsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "export_to_downloads",
    description: "Copy an asset's original media file to the user's Downloads folder",
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

      const source = join(manifest.path, file.name);
      const ext = extname(file.name);
      const dest = await resolveDestination(asset_id, ext);

      try {
        await copyFile(source, dest);
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to copy file: ${(err as Error).message}` }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "exported", path: dest }) }],
      };
    },
  };
}

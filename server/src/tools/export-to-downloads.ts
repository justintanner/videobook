import { extname, join } from "node:path";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { findOriginalMediaFile } from "../original-media-file.js";
import { copyToDownloads } from "../downloads-dest.js";
import type { ToolDef } from "./tool-def.js";

export function exportToDownloadsDef(engine: Engine): ToolDef {
  return {
    name: "export_to_downloads",
    description: "Copy an asset's original media file to the user's Downloads folder",
    schema: {
      asset_id: z.string().describe("Artifact id"),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id } = args as { asset_id: string; book_id: string };

      const artifactResult = engine.artifacts.get(asset_id);
      if (!artifactResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: artifactResult.error.message }],
        };
      }
      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const manifest = manifestResult.value;
      const file = findOriginalMediaFile(manifest.files, artifactResult.value.kind);
      if (!file) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "No original media file found for asset" }],
        };
      }

      const source = join(manifest.path, file.name);
      const ext = extname(file.name);
      let dest: string;
      try {
        dest = await copyToDownloads(source, engine.book.get().name, ext);
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

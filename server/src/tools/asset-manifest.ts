import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function assetManifestDef(engine: Engine): ToolDef {
  return {
    name: "asset_manifest",
    description: "List all files in an asset directory",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat, vid-running-dog)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id } = args as { asset_id: string; book_id: string };
      const result = await engine.files.manifest(asset_id);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
      };
    },
  };
}

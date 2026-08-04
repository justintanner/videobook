import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function updateScriptDef(fs: Engine): ToolDef {
  return {
    name: "update_script",
    description: "Update a script asset's markdown content (original.md).",
    schema: {
      asset_id: z.string().describe("Asset ID of the script"),
      content: z.string().describe("New markdown content"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, content, book_id: _book_id } = args as {
        asset_id: string;
        content: string;
        book_id: string;
      };

      const result = await fs.files.write(asset_id, "original.md", content);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, path: result.value }) }],
      };
    },
  };
}

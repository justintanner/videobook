import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { extname } from "node:path";

export function reorderCharacterImagesDef(fs: Engine): ToolDef {
  return {
    name: "reorder_character_images",
    description: "Reorder images in a character folder by renaming them sequentially (source-01, source-02, etc).",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Character asset ID"),
      ordered_filenames: z.array(z.string()).describe("List of image filenames in the desired new order"),
    },
    handler: async (payload) => {
      const { book_id: _book_id, asset_id, ordered_filenames } = payload as { book_id: string; asset_id: string; ordered_filenames: string[] };

      // Step 1: Rename all to temporary names to avoid collisions
      const tempNames: Array<{ oldName: string, tempName: string, newName: string }> = [];
      
      for (let i = 0; i < ordered_filenames.length; i++) {
        const oldName = ordered_filenames[i];
        const ext = extname(oldName).replace(/^\./, "") || "jpg";
        const tempName = `.tmp-reorder-${Date.now()}-${i}.${ext}`;
        const newName = `source-${String(i + 1).padStart(2, '0')}.${ext}`;
        
        const renameRes = await fs.files.rename(asset_id, oldName, tempName);
        if (!renameRes.ok) {
           return {
             isError: true,
             content: [{ type: "text", text: `Failed to rename ${oldName} to temp name: ${renameRes.error.message}` }],
           };
        }
        tempNames.push({ oldName, tempName, newName });
      }

      // Step 2: Rename from temp names to final sequence names
      for (const mapping of tempNames) {
        const renameRes = await fs.files.rename(asset_id, mapping.tempName, mapping.newName);
        if (!renameRes.ok) {
           return {
             isError: true,
             content: [{ type: "text", text: `Failed to rename temp file to ${mapping.newName}: ${renameRes.error.message}` }],
           };
        }
      }

      return {
        content: [{ type: "text", text: "Successfully reordered character images." }],
      };
    },
  };
}

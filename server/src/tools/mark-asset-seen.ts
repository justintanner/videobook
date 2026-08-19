import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function markAssetSeenDef(engine: Engine): ToolDef {
  return {
    name: "mark_asset_seen",
    description:
      "Mark an asset as seen so the sidebar's NEW badge clears. Idempotent: re-marking an already-seen asset is a no-op.",
    schema: {
      asset_id: z.string().describe("Asset ID to mark seen (e.g. img-cute-cat)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, book_id } = args as {
        asset_id: string;
        book_id: string;
      };
      const updated = await engine.jobs.artifactWork.markSeen(book_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ asset_id, updated }),
          },
        ],
      };
    },
  };
}


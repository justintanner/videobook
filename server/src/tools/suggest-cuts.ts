import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";

export function suggestCutsDef(engine: Engine): ToolDef {
  return {
    name: "suggest_cuts",
    description:
      "Suggest trims for visual pacing and awkward transitions from a video's frames in a background job. Uses a transcript when available for dialogue, dead air and fillers; no transcript is required. Pass the editing goal in instructions; review the result before apply_cuts.",
    schema: {
      asset_id: z.string().describe("Video artifact ID"),
      book_id: z.string().describe("Book id"),
      instructions: z.string().trim().min(1).optional().describe("Requested editing goal, such as smoother transitions and better timing"),
    },
    handler: async (args) => {
      const { asset_id, book_id, instructions } = args as { asset_id: string; book_id: string; instructions?: string };
      const assetId = asset_id.replace(/^@/, "");

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      const loaded = await loadAssetForAnalysis(engine, assetId, { requireTranscript: false });
      if (!loaded.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: loaded.error.message }],
        };
      }

      const jobId = `suggest-cuts-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "suggest_cuts",
        assetId,
        assetDir: loaded.value.manifest.path,
        bookId: book_id,
        instructions,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";

export function suggestCutsDef(engine: Engine): ToolDef {
  return {
    name: "suggest_cuts",
    description:
      "Suggest trims for a video (dead air, filler words, awkward sections) from its frames and transcript in a background job. Needs a transcript; apply the result with apply_cuts.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, book_id } = args as { asset_id: string; book_id: string };
      const assetId = asset_id.replace(/^@/, "");

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      const loaded = await loadAssetForAnalysis(engine, assetId);
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

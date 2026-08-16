import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";

export function suggestCutsDef(fs: Engine): ToolDef {
  return {
    name: "suggest_cuts",
    description:
      "Analyze a video asset (frames + transcript + metadata) and return structured trim suggestions: " +
      "dead air, filler words, awkward sections. Runs in the background and persists to .suggest-cuts.json. " +
      "Requires a transcript — run /transcribe first if missing. Use /apply-cuts to splice the result.",
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

      const loaded = await loadAssetForAnalysis(fs, assetId);
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

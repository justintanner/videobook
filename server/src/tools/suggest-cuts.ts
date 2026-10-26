import type { Engine } from "videobook-engine";
import { z } from "zod";
import { requestSidecarAnalysis } from "../analysis-sidecars.js";
import { cachedSuggestionSummary, SUGGESTED_CUTS, suggestionRecord } from "../suggestion-components.js";
import type { ToolDef } from "./tool-def.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";

export function suggestCutsDef(engine: Engine): ToolDef {
  return {
    name: "suggest_cuts",
    description:
      "Suggest trims for visual pacing and awkward transitions from a video's frames in a background job. Uses a transcript when available for dialogue, dead air and fillers; no transcript is required. Pass the editing goal in instructions; review the result before apply_cuts. Returns status cached when the same video, transcript and instructions were already reviewed; pass force for fresh suggestions.",
    schema: {
      asset_id: z.string().describe("Video artifact ID"),
      book_id: z.string().describe("Book id"),
      instructions: z.string().trim().min(1).optional().describe("Requested editing goal, such as smoother transitions and better timing"),
      force: z.boolean().optional().default(false).describe("Ask again even when the same video, transcript and instructions were already reviewed"),
    },
    handler: async (args) => {
      const { asset_id, book_id, instructions, force } = args as { asset_id: string; book_id: string; instructions?: string; force: boolean };
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

      const requested = await requestSidecarAnalysis(engine, SUGGESTED_CUTS, {
        ...await suggestionRecord(engine, SUGGESTED_CUTS, assetId, { instructions: instructions?.trim() || null }),
        force,
        payload: { assetId, assetDir: loaded.value.manifest.path, bookId: book_id, instructions },
      });
      const cached = requested.status === "cached" ? await cachedSuggestionSummary(engine, SUGGESTED_CUTS, assetId, "trims") : {};

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, job_id: requested.jobId, status: requested.status, ...cached }),
        }],
      };
    },
  };
}

import type { Engine } from "videobook-engine";
import { z } from "zod";
import { requestSidecarAnalysis } from "../analysis-sidecars.js";
import { cachedSuggestions, SUGGESTED_SFX, suggestionRecord } from "../suggestion-components.js";
import type { ToolDef } from "./tool-def.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";

export function suggestSfxDef(engine: Engine): ToolDef {
  return {
    name: "suggest_sfx",
    description:
      "Suggest timed sound effects for a video from its frames and transcript in a background job. Needs a transcript; mix the result in with apply_sfx. Returns status cached with the earlier sound effects when the same video and transcript were already reviewed; pass force for fresh suggestions.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      book_id: z.string().describe("Book id"),
      force: z.boolean().optional().default(false).describe("Ask again even when the same video and transcript were already reviewed"),
    },
    handler: async (args) => {
      const { asset_id, book_id, force } = args as { asset_id: string; book_id: string; force: boolean };
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

      const requested = await requestSidecarAnalysis(engine, SUGGESTED_SFX, {
        ...await suggestionRecord(engine, SUGGESTED_SFX, assetId, {}),
        force,
        payload: { assetId, assetDir: loaded.value.manifest.path, bookId: book_id },
      });
      const cached = requested.status === "cached" ? await cachedSuggestions(engine, SUGGESTED_SFX, assetId, "sfx") : {};

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, job_id: requested.jobId, status: requested.status, ...cached }),
        }],
      };
    },
  };
}

import type { Engine } from "videobook-engine";
import { z } from "zod";
import { requestSidecarAnalysis } from "../analysis-sidecars.js";
import { cachedSuggestionSummary, JOKES, jokesRecord } from "../suggestion-components.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import type { ElevenLabs } from "./_suggest-shared.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function hasSpokenWords(eleven: ElevenLabs): boolean {
  return Array.isArray(eleven.words) && eleven.words.some((w) => w.type === "word");
}

export function analyzeJokesDef(engine: Engine): ToolDef {
  return {
    name: "analyze_jokes",
    description:
      "Find and classify the jokes in a clip from its ElevenLabs transcript (verbatim text, start and end times, why each works) in a background job. Run transcribe first when there is no transcript. Returns status cached when the current transcript was already analysed; pass force to analyse again.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      book_id: z.string().describe("Book id"),
      force: z.boolean().optional().default(false).describe("Analyse again even when the current transcript was already analysed"),
    },
    handler: async (args) => {
      const { asset_id, book_id, force } = args as { asset_id: string; book_id: string; force: boolean };
      const assetId = asset_id.replace(/^@/, "");

      if (!process.env.OPENAI_API_KEY) {
        return error("OPENAI_API_KEY environment variable is not set");
      }

      const manifestResult = await engine.files.manifest(assetId);
      if (!manifestResult.ok) {
        return error(manifestResult.error.message);
      }

      const read = await engine.files.read(assetId, "elevenlabs.json");
      if (!read.ok) {
        return error(`No ElevenLabs transcript found for ${assetId} — run /transcribe @${assetId} first.`);
      }
      let eleven: ElevenLabs;
      try {
        eleven = JSON.parse(read.value.toString()) as ElevenLabs;
      } catch {
        return error(`elevenlabs.json for ${assetId} is not valid JSON`);
      }
      if (!hasSpokenWords(eleven)) {
        return error(`No ElevenLabs transcript found for ${assetId} — run /transcribe @${assetId} first.`);
      }

      const requested = await requestSidecarAnalysis(engine, JOKES, {
        ...await jokesRecord(engine, assetId),
        force,
        payload: { assetId, assetDir: manifestResult.value.path, bookId: book_id },
      });
      const cached = requested.status === "cached" ? await cachedSuggestionSummary(engine, JOKES, assetId, "jokes") : {};

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, job_id: requested.jobId, status: requested.status, ...cached }),
        }],
      };
    },
  };
}

import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
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
      "Find and classify the jokes in a clip from its ElevenLabs transcript (verbatim text, start and end times, why each works) in a background job. Run transcribe first when there is no transcript.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, book_id } = args as { asset_id: string; book_id: string };
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

      const jobId = `analyze-jokes-${assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "analyze_jokes",
        assetId,
        assetDir: manifestResult.value.path,
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

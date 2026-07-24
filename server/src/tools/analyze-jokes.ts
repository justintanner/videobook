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

export function analyzeJokesDef(fs: Engine): ToolDef {
  return {
    name: "analyze_jokes",
    description:
      "Analyze a clip's ElevenLabs transcript and identify the jokes in the bit, classified by type " +
      "(pun, self-deprecating, observational, etc.). Each joke includes the verbatim text, start/end " +
      "timestamps, and a one-line note on why it works. Runs in the background and persists to .analyze-jokes.json. " +
      "Requires an ElevenLabs transcript — run /transcribe first if missing.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, book_id } = args as { asset_id: string; book_id: string };
      const assetId = asset_id.replace(/^@/, "");

      if (!process.env.OPENAI_API_KEY) {
        return error("OPENAI_API_KEY environment variable is not set");
      }

      const manifestResult = await fs.files.manifest(assetId);
      if (!manifestResult.ok) {
        return error(manifestResult.error.message);
      }

      const read = await fs.files.read(assetId, "elevenlabs.json");
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

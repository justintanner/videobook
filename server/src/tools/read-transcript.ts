import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  readAssetTranscript,
  readTranscriptSidecarText,
} from "../transcript-projection.js";
import type { ToolDef } from "./tool-def.js";

export function readTranscriptDef(engine: Engine): ToolDef {
  return {
    name: "read_transcript",
    description:
      "Read the transcript for a video or audio asset. Prefers timed ElevenLabs word-level cues (elevenlabs.json), falling back to plain text (.analysis.gpt4otrans.json). Returns kind='timed' with per-word start/end cues, kind='plain' with full text, kind='silence' if a transcript exists but contains no dialog, or kind='missing' if no transcript file exists. Pass raw=true to return the untouched sidecar text instead of the parsed projection.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-clip)"),
      book_id: z.string().describe("Book id"),
      raw: z.boolean().optional().describe(
        "Return the untouched sidecar file text instead of the parsed projection",
      ),
      source: z.enum(["elevenlabs", "plain"]).optional().describe(
        "Which sidecar to read when raw=true; defaults to elevenlabs then plain",
      ),
    },
    handler: async (args) => {
      const { asset_id, raw, source } = args as {
        asset_id: string;
        book_id: string;
        raw?: boolean;
        source?: "elevenlabs" | "plain";
      };

      if (raw) {
        const sidecar = await readTranscriptSidecarText(engine, asset_id, source);
        const payload = sidecar ?? { kind: "missing" };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      }

      const transcript = await readAssetTranscript(engine, asset_id);
      const payload = transcript.kind === "timed"
        ? {
          kind: "timed",
          language_code: transcript.languageCode,
          text: transcript.text,
          words: transcript.words.map((word) => ({
            text: word.text,
            start: word.start,
            end: word.end,
            ...(word.speakerId ? { speaker_id: word.speakerId } : {}),
          })),
        }
        : transcript;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  };
}

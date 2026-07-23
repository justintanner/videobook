import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { assessDialogQuality } from "../dialog-quality.js";
import type { ToolDef } from "./tool-def.js";

interface TimedWord {
  text: string;
  start: number;
  end: number;
  type: string;
  speaker_id: string | null;
}

interface ElevenLabsTranscriptShape {
  language_code?: string;
  text?: string;
  words?: TimedWord[];
}

interface ElevenLabsMultichannelShape {
  transcripts?: ElevenLabsTranscriptShape[];
}

function extractTranscript(raw: unknown): ElevenLabsTranscriptShape | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.words !== "undefined") {
    return obj as unknown as ElevenLabsTranscriptShape;
  }
  if (Array.isArray((obj as ElevenLabsMultichannelShape).transcripts) && (obj as ElevenLabsMultichannelShape).transcripts!.length > 0) {
    return (obj as ElevenLabsMultichannelShape).transcripts![0];
  }
  return null;
}

function isTimedWord(v: unknown): v is TimedWord {
  return typeof v === "object" && v !== null
    && typeof (v as Record<string, unknown>).text === "string"
    && typeof (v as Record<string, unknown>).start === "number"
    && typeof (v as Record<string, unknown>).end === "number";
}

export function readTranscriptDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_transcript",
    description:
      "Read the transcript for a video or audio asset. Prefers timed ElevenLabs word-level cues (elevenlabs.json), falling back to plain text (.analysis.gpt4otrans.json). Returns kind='timed' with per-word start/end cues, kind='plain' with full text, kind='silence' if a transcript exists but contains no dialog, or kind='missing' if no transcript file exists.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-clip)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };

      const elevenLabsResult = await fs.readFile(asset_id, "elevenlabs.json", project_slug);
      if (elevenLabsResult.ok) {
        try {
          const raw = JSON.parse(elevenLabsResult.value.toString()) as unknown;
          const transcript = extractTranscript(raw);
          if (transcript && Array.isArray(transcript.words)) {
            const allWords = transcript.words.filter(isTimedWord);
            const speechWords = allWords.filter((w) => w.type !== "audio_event" && w.type !== "spacing");
            if (speechWords.length === 0) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ kind: "silence" }),
                }],
              };
            }
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  kind: "timed",
                  language_code: transcript.language_code ?? null,
                  text: transcript.text ?? speechWords.map((w) => w.text).join(""),
                  words: speechWords.map((w) => ({
                    text: w.text,
                    start: w.start,
                    end: w.end,
                    ...(w.speaker_id ? { speaker_id: w.speaker_id } : {}),
                  })),
                }),
              }],
            };
          }
        } catch {
          void 0;
        }
      }

      const plainResult = await fs.readFile(asset_id, ".analysis.gpt4otrans.json", project_slug);
      if (plainResult.ok) {
        try {
          const data = JSON.parse(plainResult.value.toString()) as { text?: string };
          const quality = assessDialogQuality(data);
          if (!quality.hasDialog && (quality.reason === "empty" || quality.reason === "noise_only")) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ kind: "silence" }),
              }],
            };
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ kind: "plain", text: quality.text }),
            }],
          };
        } catch {
          void 0;
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ kind: "missing" }),
        }],
      };
    },
  };
}

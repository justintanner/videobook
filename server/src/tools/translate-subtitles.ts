import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

export function translateSubtitlesDef(fs: Engine): ToolDef {
  return {
    name: "translate_subtitles",
    description:
      "Translate an asset's transcribed subtitles into another language. Writes elevenlabs.<lang>.json next to elevenlabs.json; renders with subtitle_language set to that language use it. Cached per language — re-runs only after re-transcription.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid-* or aud-*)"),
      book_id: z.string().describe("Project slug"),
      language: z
        .string()
        .regex(/^[a-z]{2}$/)
        .describe("Target language as a two-letter ISO 639-1 code (e.g. 'en')"),
    },
    handler: async (args) => {
      const { asset_id, book_id, language } = args as {
        asset_id: string;
        book_id: string;
        language: string;
      };

      if (!asset_id.startsWith("vid-") && !asset_id.startsWith("aud-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "asset_id must start with vid- or aud-" }],
        };
      }

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const hasTranscript = manifestResult.value.files.some((f) => f.name === "elevenlabs.json");
      if (!hasTranscript) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No elevenlabs.json in asset ${asset_id}. Transcribe the asset first.`,
          }],
        };
      }

      const jobId = `translate-${asset_id}-${language}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "translate_transcript",
        assetId: asset_id,
        bookId: book_id,
        targetLanguage: language,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, language, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

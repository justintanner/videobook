import type { Engine } from "videobook-engine";
import { z } from "zod";
import { cachedSidecarAnalysis, requestSidecarAnalysis } from "../analysis-sidecars.js";
import { iso1FromIso3, readLanguageCode } from "../jobs/_translate-transcript.js";
import { TIMED_TRANSCRIPT_FILE } from "../transcript-projection.js";
import { readArtifactJson, transcriptTranslationRecord, transcriptTranslationSpec } from "../transcript-translation.js";
import type { ToolDef } from "./tool-def.js";
import { requireArtifactKind } from "./_shared.js";

export function translateSubtitlesDef(engine: Engine): ToolDef {
  return {
    name: "translate_subtitles",
    description:
      "Translate an asset's transcript subtitles into another language for renders with that subtitle_language. Returns status cached when the current transcript already has that translation; a repeated or concurrent request joins the running job.",
    schema: {
      asset_id: z.string().describe("Video or audio artifact id"),
      book_id: z.string().describe("Book id"),
      language: z
        .string()
        .regex(/^[a-z]{2}$/)
        .describe("Target language as a two-letter ISO 639-1 code (e.g. 'en')"),
      force: z.boolean().optional().default(false).describe("Translate again even when the current transcript already has this translation"),
    },
    handler: async (args) => {
      const { asset_id, book_id, language, force } = args as {
        asset_id: string;
        book_id: string;
        language: string;
        force: boolean;
      };

      const kindGate = await requireArtifactKind(engine, asset_id, ["video", "audio"], "translate_subtitles");
      if (kindGate) return kindGate;

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const transcript = manifestResult.value.files.find((f) => f.name === TIMED_TRANSCRIPT_FILE);
      if (!transcript) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No elevenlabs.json in asset ${asset_id}. Transcribe the asset first.`,
          }],
        };
      }

      if (iso1FromIso3(readLanguageCode(await readArtifactJson(engine, asset_id, TIMED_TRANSCRIPT_FILE))) === language) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id, language, job_id: null, status: "not_needed", reason: `The transcript is already in ${language}.` }),
          }],
        };
      }

      const spec = transcriptTranslationSpec(language);
      const record = transcriptTranslationRecord(engine, asset_id, transcript.objectHash, language);
      if ((force || !await cachedSidecarAnalysis(engine, spec, record)) && !process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }
      const requested = await requestSidecarAnalysis(engine, spec, {
        ...record,
        force,
        payload: { assetId: asset_id, bookId: book_id, targetLanguage: language },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, language, job_id: requested.jobId, status: requested.status }),
        }],
      };
    },
  };
}

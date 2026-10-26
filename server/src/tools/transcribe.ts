import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { waitForBookJob } from "../queue.js";
import { findAudioFile, findVideoFile } from "videobook-engine";
import type { SidecarAnalysisSpec, SidecarInput, SidecarRequest } from "../analysis-sidecars.js";
import { requestSidecarAnalysis } from "../analysis-sidecars.js";
import {
  ELEVENLABS_TRANSCRIPT,
  elevenLabsTranscriptRecord,
  OPENAI_TRANSCRIPT,
  openAiTranscriptRecord,
} from "../transcript-components.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

type TranscribeArgs = {
  asset_id: string;
  book_id: string;
  language_code?: string;
  tag_audio_events: boolean;
  diarize: boolean;
  wait: boolean;
  force: boolean;
};

interface TranscriptRequest {
  provider: "elevenlabs" | "openai";
  spec: SidecarAnalysisSpec;
  record: SidecarInput;
  payload: Record<string, unknown> & { bookId: string };
}

function elevenLabsRequest(args: TranscribeArgs, assetDir: string, audioFile: ArtifactManifestFile): TranscriptRequest {
  const options = { tagAudioEvents: args.tag_audio_events, diarize: args.diarize, ...(args.language_code ? { languageCode: args.language_code } : {}) };
  return {
    provider: "elevenlabs",
    spec: ELEVENLABS_TRANSCRIPT,
    record: elevenLabsTranscriptRecord({ artifactId: args.asset_id, audioHash: audioFile.objectHash, options }),
    payload: {
      audioPath: join(assetDir, audioFile.name),
      audioFilename: audioFile.name,
      ...options,
      assetId: args.asset_id,
      assetDir,
      bookId: args.book_id,
    },
  };
}

function openAiRequest(args: TranscribeArgs, assetDir: string, mediaFile: ArtifactManifestFile): TranscriptRequest {
  return {
    provider: "openai",
    spec: OPENAI_TRANSCRIPT,
    record: openAiTranscriptRecord(args.asset_id, mediaFile.objectHash),
    payload: {
      videoPath: join(assetDir, mediaFile.name),
      sourceFilename: mediaFile.name,
      assetId: args.asset_id,
      assetDir,
      bookId: args.book_id,
    },
  };
}

function response(args: TranscribeArgs, request: TranscriptRequest, requested: SidecarRequest, status: string): ToolResult {
  return ok({ asset_id: args.asset_id, provider: request.provider, status, job_id: requested.jobId });
}

export function transcribeDef(engine: Engine): ToolDef {
  return {
    name: "transcribe",
    description: "Transcribe a video or audio asset: word-timed ElevenLabs speech-to-text when available, otherwise OpenAI speech-to-text. Returns status cached when the current audio already has a transcript with these settings; a repeated or concurrent request joins the running job.",
    schema: {
      asset_id: z.string().describe("Video or audio artifact id"),
      book_id: z.string().describe("Book UUID"),
      language_code: z.string().optional().describe("Language code (e.g. 'en'). Auto-detected if omitted."),
      tag_audio_events: z.boolean().optional().default(true).describe("Tag audio events like laughter, music, etc."),
      diarize: z.boolean().optional().default(true).describe("Enable speaker diarization"),
      wait: z.boolean().optional().default(false).describe("Wait for the transcription job to finish before returning (default: return as soon as the job is enqueued)"),
      force: z.boolean().optional().default(false).describe("Transcribe again even when the current audio already has a transcript with these settings"),
    },
    handler: async (rawArgs) => {
      const args = rawArgs as TranscribeArgs;
      const hasElevenLabsKey = Boolean(process.env.ELEVENLABS_API_KEY);
      const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
      if (!hasElevenLabsKey && !hasOpenAiKey) {
        return error(
          "Speech-to-text needs ELEVENLABS_API_KEY or OPENAI_API_KEY — neither is set",
        );
      }

      const artifactResult = engine.artifacts.get(args.asset_id);
      if (!artifactResult.ok) return error(artifactResult.error.message);

      const manifestResult = await engine.files.manifest(args.asset_id);
      if (!manifestResult.ok) return error(manifestResult.error.message);

      const manifest = manifestResult.value;
      const audioFile = findAudioFile(manifest.files, artifactResult.value.kind);
      const mediaFile = audioFile ?? findVideoFile(manifest.files);
      if (!mediaFile) {
        return error(`No audio file found in artifact ${args.asset_id}`);
      }
      const useElevenLabs = hasElevenLabsKey && audioFile !== null;
      if (!useElevenLabs && !hasOpenAiKey) {
        return error(`No audio file found in artifact ${args.asset_id}`);
      }

      const request = useElevenLabs && audioFile
        ? elevenLabsRequest(args, manifest.path, audioFile)
        : openAiRequest(args, manifest.path, mediaFile);
      const requested = await requestSidecarAnalysis(engine, request.spec, { ...request.record, force: args.force, payload: request.payload });
      if (!args.wait || requested.status === "cached" || requested.jobId === null) {
        return response(args, request, requested, requested.status);
      }
      try {
        await waitForBookJob(args.book_id, requested.jobId);
      } catch (err) {
        return error(
          `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return response(args, request, requested, "completed");
    },
  };
}

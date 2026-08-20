import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "videobook-engine";
import type { ToolDef, ToolResult } from "./tool-def.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function transcribeDef(engine: Engine): ToolDef {
  return {
    name: "transcribe",
    description: "Transcribe audio from a video or audio asset. Uses ElevenLabs speech-to-text when an audio file and ELEVENLABS_API_KEY are available (writes word-timed elevenlabs.json), otherwise falls back to OpenAI speech-to-text straight off the video (writes .analysis.gpt4otrans.json).",
    schema: {
      asset_id: z.string().describe("Video or audio artifact id"),
      book_id: z.string().describe("Book UUID"),
      language_code: z.string().optional().describe("Language code (e.g. 'en'). Auto-detected if omitted."),
      tag_audio_events: z.boolean().optional().default(true).describe("Tag audio events like laughter, music, etc."),
      diarize: z.boolean().optional().default(true).describe("Enable speaker diarization"),
      wait: z.boolean().optional().default(false).describe("Wait for the transcription job to finish before returning (default: return as soon as the job is enqueued)"),
    },
    handler: async (args) => {
      const { asset_id, book_id, language_code, tag_audio_events, diarize, wait } = args as {
        asset_id: string;
        book_id: string;
        language_code?: string;
        tag_audio_events: boolean;
        diarize: boolean;
        wait: boolean;
      };

      const hasElevenLabsKey = Boolean(process.env.ELEVENLABS_API_KEY);
      const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
      if (!hasElevenLabsKey && !hasOpenAiKey) {
        return error(
          "Speech-to-text needs ELEVENLABS_API_KEY or OPENAI_API_KEY — neither is set",
        );
      }

      const artifactResult = engine.artifacts.get(asset_id);
      if (!artifactResult.ok) return error(artifactResult.error.message);

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) return error(manifestResult.error.message);

      const manifest = manifestResult.value;
      const audioFile = findAudioFile(manifest.files, artifactResult.value.kind);
      // ElevenLabs needs a standalone audio track; without one (or without its
      // key) OpenAI speech-to-text reads the video file directly.
      const mediaFile = audioFile ?? findVideoFile(manifest.files);
      if (!mediaFile) {
        return error(`No audio file found in artifact ${asset_id}`);
      }
      const useElevenLabs = hasElevenLabsKey && audioFile !== null;
      if (!useElevenLabs && !hasOpenAiKey) {
        return error(`No audio file found in artifact ${asset_id}`);
      }

      const provider = useElevenLabs ? "elevenlabs" : "openai";
      const jobId = `transcribe-${asset_id}-${Date.now()}`;
      const jobPayload = (useElevenLabs
        ? {
          type: "transcribe",
          audioPath: join(manifest.path, mediaFile.name),
          audioFilename: mediaFile.name,
          tagAudioEvents: tag_audio_events,
          diarize,
          ...(language_code ? { languageCode: language_code } : {}),
          assetId: asset_id,
          assetDir: manifest.path,
          bookId: book_id,
        }
        : {
          type: "transcribe_video_audio",
          videoPath: join(manifest.path, mediaFile.name),
          sourceFilename: mediaFile.name,
          assetId: asset_id,
          assetDir: manifest.path,
          bookId: book_id,
        }) as unknown as Record<string, unknown>;

      if (wait) {
        try {
          await queue.enqueueAndWait(jobId, jobPayload);
        } catch (err) {
          return error(
            `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id, job_id: jobId, provider, status: "completed" }),
          }],
        };
      }

      await queue.enqueue(jobId, jobPayload);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, provider, status: "enqueued" }),
        }],
      };
    },
  };
}

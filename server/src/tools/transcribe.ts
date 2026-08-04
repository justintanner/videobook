import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

export function transcribeDef(fs: Engine): ToolDef {
  return {
    name: "transcribe",
    description: "Transcribe audio from a video or audio asset using ElevenLabs speech-to-text. Writes elevenlabs.json into the asset directory.",
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

      if (!process.env.ELEVENLABS_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "ELEVENLABS_API_KEY environment variable is not set" }],
        };
      }

      const artifactResult = fs.artifacts.get(asset_id);
      if (!artifactResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: artifactResult.error.message }],
        };
      }

      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;

      const audioFile = findAudioFile(manifest.files, artifactResult.value.kind);
      if (!audioFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No audio file found in artifact ${asset_id}` }],
        };
      }

      const audioPath = join(manifest.path, audioFile.name);
      const jobId = `transcribe-${asset_id}-${Date.now()}`;
      const jobPayload = {
        type: "transcribe",
        audioPath,
        audioFilename: audioFile.name,
        tagAudioEvents: tag_audio_events,
        diarize,
        ...(language_code ? { languageCode: language_code } : {}),
        assetId: asset_id,
        assetDir: manifest.path,
        bookId: book_id,
      } as unknown as Record<string, unknown>;

      if (wait) {
        try {
          await queue.enqueueAndWait(jobId, jobPayload);
        } catch (err) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id, job_id: jobId, status: "completed" }),
          }],
        };
      }

      await queue.enqueue(jobId, jobPayload);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}


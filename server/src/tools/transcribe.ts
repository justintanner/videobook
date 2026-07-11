import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";

export function transcribeDef(fs: VideocityFs): ToolDef {
  return {
    name: "transcribe",
    description: "Transcribe audio from a video or audio asset using ElevenLabs speech-to-text. Writes elevenlabs.json into the asset directory.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid-* or aud-*)"),
      project_slug: z.string().describe("Project slug"),
      language_code: z.string().optional().describe("Language code (e.g. 'en'). Auto-detected if omitted."),
      tag_audio_events: z.boolean().optional().default(true).describe("Tag audio events like laughter, music, etc."),
      diarize: z.boolean().optional().default(true).describe("Enable speaker diarization"),
      wait: z.boolean().optional().default(false).describe("Wait for the transcription job to finish before returning (default: return as soon as the job is enqueued)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, language_code, tag_audio_events, diarize, wait } = args as {
        asset_id: string;
        project_slug: string;
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

      const manifestResult = await fs.getManifest(asset_id, project_slug, { includeDotfiles: true });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;

      const audioFile = findAudioFile(manifest.files, asset_id);
      if (!audioFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No audio file found in asset ${asset_id}` }],
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
        projectSlug: project_slug,
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


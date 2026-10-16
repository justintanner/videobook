import type { Engine } from "videobook-engine";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import type { ToolDef } from "./tool-def.js";

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function archiveClipDef(engine: Engine): ToolDef {
  return {
    name: "archive_clip",
    description: "Save a URL or a video or audio asset to the global clip archive (B2 when configured, otherwise local), deduplicated by content and transcribed; restore it with restore_archive_clips.",
    schema: {
      url: z.string().optional().describe("Source URL to download in full"),
      asset_id: z.string().optional().describe("Existing video/audio asset ID to archive"),
      book_id: z.string().uuid().describe("Book UUID"),
      title: z.string().optional().describe("Optional archive title"),
      topics: z.array(z.string()).optional().default([]).describe("Search topics to attach to this clip"),
      people: z.array(z.string()).optional().default([]).describe("Named people to attach to this clip"),
      language_code: z.string().optional().describe("Language code (e.g. 'en'). Auto-detected if omitted."),
      tag_audio_events: z.boolean().optional().default(true).describe("Tag audio events like laughter, music, etc."),
      diarize: z.boolean().optional().default(true).describe("Enable speaker diarization"),
    },
    handler: async (args) => {
      const {
        url,
        asset_id,
        book_id,
        title,
        topics,
        people,
        language_code,
        tag_audio_events,
        diarize,
      } = args as {
        url?: string;
        asset_id?: string;
        book_id: string;
        title?: string;
        topics: string[];
        people: string[];
        language_code?: string;
        tag_audio_events: boolean;
        diarize: boolean;
      };

      if ((url ? 1 : 0) + (asset_id ? 1 : 0) !== 1) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "archive_clip requires exactly one of url or asset_id" }],
        };
      }

      if (!getApiKey("ELEVENLABS_API_KEY")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "ELEVENLABS_API_KEY environment variable is not set or is a placeholder" }],
        };
      }

      if (asset_id) {
        const manifest = await engine.files.manifest(asset_id);
        if (!manifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: manifest.error.message }],
          };
        }
      }

      const ingestId = randomUUID();
      const jobId = `archive-clip-${ingestId}`;
      await queue.enqueue(jobId, {
        type: "archive_clip",
        bookId: book_id,
        ...(asset_id ? { assetId: asset_id } : {}),
        ...(url ? { url: normalizeUrl(url) } : {}),
        ...(title ? { title } : {}),
        topics,
        people,
        tagAudioEvents: tag_audio_events,
        diarize,
        ingestId,
        ...(language_code ? { languageCode: language_code } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "enqueued",
            job_id: jobId,
            ingest_id: ingestId,
            archive_id: null,
          }),
        }],
      };
    },
  };
}

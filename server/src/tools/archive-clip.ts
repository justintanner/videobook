import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import type { ToolDef } from "./tool-def.js";

async function resolveQueueProjectSlug(fs: VideocityFs, projectSlug: string | undefined): Promise<string> {
  if (projectSlug) return projectSlug;
  const existing = await fs.getProject();
  if (existing.ok) return existing.value.metadata.slug;
  const created = await fs.createProject();
  if (created.ok) return created.value.slug;
  throw new Error(created.error.message);
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export function archiveClipDef(fs: VideocityFs): ToolDef {
  return {
    name: "archive_clip",
    description: "Archive a full URL or existing video/audio asset to the global clip archive (B2 if configured, otherwise a local archive folder next to the projects directory), dedupe by media SHA-256, and transcribe long clips in chunks.",
    schema: {
      url: z.string().optional().describe("Source URL to download in full"),
      asset_id: z.string().optional().describe("Existing video/audio asset ID to archive"),
      project_slug: z.string().optional().describe("Required for asset_id; optional queue anchor for URL archives"),
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
        project_slug,
        title,
        topics,
        people,
        language_code,
        tag_audio_events,
        diarize,
      } = args as {
        url?: string;
        asset_id?: string;
        project_slug?: string;
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

      if (asset_id && !project_slug) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "project_slug is required when asset_id is used" }],
        };
      }

      if (!getApiKey("ELEVENLABS_API_KEY")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "ELEVENLABS_API_KEY environment variable is not set or is a placeholder" }],
        };
      }

      let queueProjectSlug: string;
      try {
        queueProjectSlug = await resolveQueueProjectSlug(fs, project_slug);
      } catch (error) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        };
      }

      if (asset_id && project_slug) {
        const manifest = await fs.getManifest(asset_id, project_slug, { includeDotfiles: true });
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
        projectSlug: queueProjectSlug,
        ...(asset_id ? { assetId: asset_id, sourceProjectSlug: project_slug } : {}),
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


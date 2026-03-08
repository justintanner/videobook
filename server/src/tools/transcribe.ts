import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";
import { WHITELISTED_AT_FILE } from "./whitelist-asset.js";

export function transcribeDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "transcribe",
    description: "Transcribe audio from a video or audio asset using ElevenLabs speech-to-text. Writes elevenlabs.json into the asset directory.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid-* or aud-*)"),
      project_slug: z.string().describe("Project slug"),
      language_code: z.string().optional().describe("Language code (e.g. 'en'). Auto-detected if omitted."),
      tag_audio_events: z.boolean().optional().default(true).describe("Tag audio events like laughter, music, etc."),
      diarize: z.boolean().optional().default(true).describe("Enable speaker diarization"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, language_code, tag_audio_events, diarize } = args as {
        asset_id: string;
        project_slug: string;
        language_code?: string;
        tag_audio_events: boolean;
        diarize: boolean;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;

      if (asset_id.startsWith("vid-")) {
        const isWhitelisted = manifest.files.some(
          (f) => f.name === WHITELISTED_AT_FILE,
        );
        if (!isWhitelisted) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Asset ${asset_id} must be whitelisted before transcription. Use whitelist_asset to mark it as ready.`,
            }],
          };
        }
      }

      const audioFile = findAudioFile(manifest.files, asset_id);
      if (!audioFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No audio file found in asset ${asset_id}` }],
        };
      }

      const audioPath = join(manifest.path, audioFile.name);
      const jobId = `transcribe-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "transcribe",
        audioPath,
        audioFilename: audioFile.name,
        tagAudioEvents: tag_audio_events,
        diarize,
        ...(language_code ? { languageCode: language_code } : {}),
        assetId: asset_id,
        assetDir: manifest.path,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

export function registerTranscribeTool(server: McpServer, fs: ClipfirstFs): void {
  const def = transcribeDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

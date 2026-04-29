/**
 * isolate_vocals MCP tool — isolates vocals from video/audio assets
 * via ElevenLabs cloud API through KIE.
 */
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";

export function isolateVocalsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "isolate_vocals",
    description:
      "Isolate vocals from a video or audio asset using ElevenLabs audio-isolation via KIE. " +
      "Writes audio_vocals.mp3 (for video assets) or mix.mp3 + .mix.json (for audio assets).",
    schema: {
      asset_id: z.string().describe("Asset ID (vid-* or aud-*)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as {
        asset_id: string;
        project_slug: string;
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
      const audioFile = findAudioFile(manifest.files, asset_id);
      if (!audioFile) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No audio file found in asset ${asset_id}`,
          }],
        };
      }

      const audioPath = join(manifest.path, audioFile.name);
      const jobId = `isolate-vocals-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "isolate_vocals",
        audioPath,
        audioFilename: audioFile.name,
        assetId: asset_id,
        assetDir: manifest.path,
        projectSlug: project_slug,
        isAudioAsset: asset_id.startsWith("aud-"),
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

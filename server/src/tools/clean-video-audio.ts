import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { requireArtifactKind, toolError } from "./_shared.js";

const DEFAULT_SOURCE_MIX = 0.22;
const DEFAULT_EDGE_FADE_MS = 250;
const DEFAULT_MUSIC_VOLUME = 0.08;

export function cleanVideoAudioDef(fs: Engine): ToolDef {
  return {
    name: "clean_video_audio",
    description:
      "Clean a video artifact's audio in place with ElevenLabs Voice Isolator. Preserves dialogue as the main track, keeps a quiet denoised source bed for important sound effects, suppresses odd start/end sounds with fades, and can add subtle instrumental ElevenLabs music. The video stream is copied unchanged and process_video refreshes derived audio artifacts.",
    schema: {
      asset_id: z.string().describe("Video artifact id (with or without a leading @)"),
      book_id: z.string().describe("Book id"),
      source_mix: z
        .number()
        .min(0)
        .max(0.5)
        .optional()
        .describe(`Original denoised effects/ambience level from 0 to 0.5 (default ${DEFAULT_SOURCE_MIX})`),
      edge_fade_ms: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe(`Start and end fade length used to suppress boundary noise (default ${DEFAULT_EDGE_FADE_MS}ms)`),
      add_light_music: z
        .boolean()
        .optional()
        .describe("Generate and mix a light instrumental music bed"),
      music_prompt: z
        .string()
        .min(1)
        .max(4100)
        .optional()
        .describe("Optional ElevenLabs Music direction; providing it also enables music"),
      music_volume: z
        .number()
        .min(0.01)
        .max(0.25)
        .optional()
        .describe(`Music level from 0.01 to 0.25 (default ${DEFAULT_MUSIC_VOLUME})`),
    },
    handler: async (args) => {
      if (!process.env.ELEVENLABS_API_KEY) {
        return toolError("ELEVENLABS_API_KEY environment variable is not set");
      }

      const {
        asset_id,
        book_id,
        source_mix,
        edge_fade_ms,
        add_light_music,
        music_prompt,
        music_volume,
      } = args as {
        asset_id: string;
        book_id: string;
        source_mix?: number;
        edge_fade_ms?: number;
        add_light_music?: boolean;
        music_prompt?: string;
        music_volume?: number;
      };
      const assetId = asset_id.replace(/^@/, "");
      const kindGate = await requireArtifactKind(fs, assetId, ["video"], "clean_video_audio");
      if (kindGate) return kindGate;

      const manifestResult = await fs.files.manifest(assetId);
      if (!manifestResult.ok) return toolError(manifestResult.error.message);

      const manifest = manifestResult.value;
      const videoFile = manifest.files.find((file) => file.name.toLowerCase() === "original.mp4")
        ?? findVideoFile(manifest.files);
      if (!videoFile) return toolError(`No video file found in asset ${assetId}`);

      const trimmedMusicPrompt = music_prompt?.trim() || null;
      const addMusic = add_light_music === true || trimmedMusicPrompt !== null;
      const jobId = `clean-video-audio-${assetId}-${Date.now()}`;

      try {
        await queue.enqueue(jobId, {
          type: "clean_video_audio",
          assetId,
          assetDir: manifest.path,
          videoFilename: videoFile.name,
          bookId: book_id,
          sourceMix: source_mix ?? DEFAULT_SOURCE_MIX,
          edgeFadeMs: edge_fade_ms ?? DEFAULT_EDGE_FADE_MS,
          addMusic,
          musicPrompt: trimmedMusicPrompt,
          musicVolume: music_volume ?? DEFAULT_MUSIC_VOLUME,
        });
      } catch (error) {
        return toolError(`Audio cleanup could not be enqueued: ${error instanceof Error ? error.message : String(error)}`);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: assetId,
            job_id: jobId,
            status: "enqueued",
            source_mix: source_mix ?? DEFAULT_SOURCE_MIX,
            edge_fade_ms: edge_fade_ms ?? DEFAULT_EDGE_FADE_MS,
            light_music: addMusic,
          }),
        }],
      };
    },
  };
}

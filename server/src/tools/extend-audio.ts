import { join } from "node:path";
import { findAudioFile, type VideocityFs } from "videocity-engine";
import { z } from "zod";
import {
  MAX_AUDIO_CONTINUATION_MS,
  MAX_CONTINUATION_DIRECTION_CHARS,
  MAX_SOUND_GENERATION_PROMPT_CHARS,
  MIN_AUDIO_CONTINUATION_MS,
  normalizeContinuationPrompt,
} from "../elevenlabs-audio-extension.js";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { toolError } from "./_shared.js";
import type { ToolDef } from "./tool-def.js";

function defaultExtendedName(assetId: string, targetDurationSeconds: number): string {
  const base = assetId.replace(/^aud-/, "");
  const duration = String(targetDurationSeconds).replace(".", "-");
  return `extended-${base}-${duration}s`;
}

export function extendAudioDef(fs: VideocityFs): ToolDef {
  return {
    name: "extend_audio_asset",
    description: "Extend an existing aud-* asset to a requested total duration with a smooth ElevenLabs continuation. Uses Scribe to understand the source, generates a matching continuation, preserves the source at the beginning, and creates a new aud-* asset.",
    schema: {
      asset_id: z.string().describe("Source aud-* asset ID"),
      target_duration_seconds: z.number().positive().describe("Requested total output duration in seconds"),
      continuation_prompt: z.string().min(1).max(MAX_SOUND_GENERATION_PROMPT_CHARS).optional().describe('Optional direction for what should follow the source audio, e.g. "add outro music"'),
      asset_name: z.string().min(1).optional().describe("Optional name for the new aud-* asset"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const {
        asset_id,
        target_duration_seconds,
        continuation_prompt,
        asset_name,
        project_slug,
      } = args as {
        asset_id: string;
        target_duration_seconds: number;
        continuation_prompt?: string;
        asset_name?: string;
        project_slug: string;
      };

      if (!process.env.ELEVENLABS_API_KEY) {
        return toolError("ELEVENLABS_API_KEY environment variable is not set");
      }

      const sourceAssetId = asset_id.replace(/^@/, "");
      if (!sourceAssetId.startsWith("aud-")) {
        return toolError(`extend_audio requires an aud-* source, got ${sourceAssetId}`);
      }

      const continuationPrompt = normalizeContinuationPrompt(continuation_prompt);
      if (continuationPrompt && continuationPrompt.length > MAX_CONTINUATION_DIRECTION_CHARS) {
        return toolError(`continuation_prompt supports at most ${MAX_CONTINUATION_DIRECTION_CHARS} characters of direction`);
      }

      const manifest = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: true });
      if (!manifest.ok) return toolError(manifest.error.message);
      const audioFile = findAudioFile(manifest.value.files, sourceAssetId);
      if (!audioFile) return toolError(`No audio file found in asset ${sourceAssetId}`);

      let sourceDurationSeconds: number;
      try {
        const probe = await probeVideo(join(manifest.value.path, audioFile.name));
        sourceDurationSeconds = probe.audioDuration ?? probe.duration;
      } catch (error) {
        return toolError(`Failed to probe ${sourceAssetId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
        return toolError(`Could not determine a valid duration for ${sourceAssetId}`);
      }

      const sourceDurationMs = Math.round(sourceDurationSeconds * 1000);
      const targetDurationMs = Math.round(target_duration_seconds * 1000);
      if (targetDurationMs <= sourceDurationMs) {
        return toolError(`Target duration must exceed the source duration of ${(sourceDurationMs / 1000).toFixed(3)}s`);
      }
      const continuationDurationMs = targetDurationMs - sourceDurationMs;
      if (continuationDurationMs < MIN_AUDIO_CONTINUATION_MS) {
        return toolError(`ElevenLabs requires at least ${(MIN_AUDIO_CONTINUATION_MS / 1000).toFixed(1)}s of new continuation`);
      }
      if (continuationDurationMs > MAX_AUDIO_CONTINUATION_MS) {
        return toolError(`ElevenLabs Sound Generation supports at most ${(MAX_AUDIO_CONTINUATION_MS / 1000).toFixed(1)}s of new continuation per request`);
      }

      const name = asset_name?.trim() || defaultExtendedName(sourceAssetId, target_duration_seconds);
      const created = await fs.createAsset("aud", name, project_slug);
      if (!created.ok) return toolError(`Failed to create audio asset: ${created.error.message}`);

      const jobId = `extend-audio-${created.value.assetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "extend_audio",
        audAssetId: created.value.assetId,
        sourceAssetId,
        sourceFilename: audioFile.name,
        sourceDurationMs,
        targetDurationMs,
        continuationPrompt,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            aud_asset_id: created.value.assetId,
            source_audio_asset_id: sourceAssetId,
            source_duration_seconds: sourceDurationMs / 1000,
            target_duration_seconds: targetDurationMs / 1000,
            continuation_duration_seconds: (targetDurationMs - sourceDurationMs) / 1000,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

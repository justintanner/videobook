import { join } from "node:path";
import { findAudioFile, type Artifact, type Engine } from "videobook-engine";
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

function defaultExtendedName(source: Artifact, targetDurationSeconds: number): string {
  const base = source.label ?? source.artifactId;
  const duration = String(targetDurationSeconds).replace(".", "-");
  return `extended-${base}-${duration}s`;
}

export function extendAudioDef(fs: Engine): ToolDef {
  return {
    name: "extend_audio_asset",
    description: "Extend an existing audio asset to a requested total duration with a smooth ElevenLabs continuation. Uses Scribe to understand the source, generates a matching continuation, preserves the source at the beginning, and creates a new audio asset.",
    schema: {
      asset_id: z.string().describe("Source audio artifact id"),
      target_duration_seconds: z.number().positive().describe("Requested total output duration in seconds"),
      continuation_prompt: z.string().min(1).max(MAX_SOUND_GENERATION_PROMPT_CHARS).optional().describe('Optional direction for what should follow the source audio, e.g. "add outro music"'),
      asset_name: z.string().min(1).optional().describe("Optional name for the new audio asset"),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const {
        asset_id,
        target_duration_seconds,
        continuation_prompt,
        asset_name,
        book_id,
      } = args as {
        asset_id: string;
        target_duration_seconds: number;
        continuation_prompt?: string;
        asset_name?: string;
        book_id: string;
      };

      if (!process.env.ELEVENLABS_API_KEY) {
        return toolError("ELEVENLABS_API_KEY environment variable is not set");
      }

      const sourceAssetId = asset_id.replace(/^@/, "");
      const sourceArtifact = fs.artifacts.get(sourceAssetId);
      if (!sourceArtifact.ok) return toolError(sourceArtifact.error.message);
      if (sourceArtifact.value.kind !== "audio") {
        return toolError(`extend_audio requires an audio source, got ${sourceArtifact.value.kind} artifact ${sourceAssetId}`);
      }

      const continuationPrompt = normalizeContinuationPrompt(continuation_prompt);
      if (continuationPrompt && continuationPrompt.length > MAX_CONTINUATION_DIRECTION_CHARS) {
        return toolError(`continuation_prompt supports at most ${MAX_CONTINUATION_DIRECTION_CHARS} characters of direction`);
      }

      const manifest = await fs.files.manifest(sourceAssetId);
      if (!manifest.ok) return toolError(manifest.error.message);
      const audioFile = findAudioFile(manifest.value.files, sourceArtifact.value.kind);
      if (!audioFile) return toolError(`No audio file found in artifact ${sourceAssetId}`);

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

      const name = asset_name?.trim() || defaultExtendedName(sourceArtifact.value, target_duration_seconds);
      const created = await fs.artifacts.create("audio", name);
      if (!created.ok) return toolError(`Failed to create audio asset: ${created.error.message}`);

      const jobId = `extend-audio-${created.value.artifactId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "extend_audio",
        audAssetId: created.value.artifactId,
        sourceAssetId,
        sourceFilename: audioFile.name,
        sourceDurationMs,
        targetDurationMs,
        continuationPrompt,
        bookId: book_id,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            aud_asset_id: created.value.artifactId,
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

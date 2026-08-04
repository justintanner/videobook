import {
  findAudioFile,
  findVideoFile,
  type Engine,
} from "videobook-engine";
import { z } from "zod";
import type { RemoveSoundAssetKind, RemoveSoundResult } from "../jobs/remove-sound.js";
import { queue } from "../queue.js";
import { toolError } from "./_shared.js";
import type { ToolDef } from "./tool-def.js";

const JOB_TIMEOUT_MS = 30 * 60_000;

export function removeSoundDef(fs: Engine): ToolDef {
  return {
    name: "remove_sound",
    description: "Remove a described sound (e.g. a horse neigh) from a video or audio asset in place. ElevenLabs Scribe tags audio events with timestamps, events matching the description are silenced with short fades, and video streams are preserved untouched with git versioning.",
    schema: {
      asset_id: z.string().describe("Artifact id to edit in-place (video or audio)"),
      sound: z.string().min(1).max(200).describe('Description of the sound to remove, e.g. "horse neighing"'),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const { asset_id, sound, book_id } = args as {
        asset_id: string;
        sound: string;
        book_id: string;
      };

      if (!process.env.ELEVENLABS_API_KEY) {
        return toolError("ELEVENLABS_API_KEY environment variable is not set");
      }

      const assetId = asset_id.replace(/^@/, "");
      const artifact = fs.artifacts.get(assetId);
      if (!artifact.ok) return toolError(artifact.error.message);
      const kind: RemoveSoundAssetKind | null = artifact.value.kind === "video"
        ? "video"
        : artifact.value.kind === "audio" ? "audio" : null;
      if (!kind) {
        return toolError(`remove_sound only supports video or audio artifacts, got ${artifact.value.kind} artifact ${assetId}`);
      }

      const manifest = await fs.files.manifest(assetId);
      if (!manifest.ok) return toolError(manifest.error.message);
      const file = kind === "video"
        ? findVideoFile(manifest.value.files)
        : findAudioFile(manifest.value.files, artifact.value.kind);
      if (!file) {
        return toolError(`No ${kind} file found in artifact ${assetId}`);
      }

      const jobId = `remove-sound-${assetId}-${Date.now()}`;
      let result: RemoveSoundResult;
      try {
        result = await queue.enqueueAndWait<RemoveSoundResult>(jobId, {
          type: "remove_sound",
          assetId,
          assetKind: kind,
          assetDir: manifest.value.path,
          filename: file.name,
          sound: sound.trim(),
          bookId: book_id,
        } as unknown as Record<string, unknown>, JOB_TIMEOUT_MS);
      } catch (error) {
        return toolError(`Sound removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: result.asset_id,
            sound: result.sound,
            matched_events: result.matched_events,
            removed_segments: result.removed_segments,
            removed_seconds: result.removed_seconds,
            detected_events: result.detected_events,
            job_id: jobId,
            status: "completed",
          }),
        }],
      };
    },
  };
}

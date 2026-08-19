import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

const MIN_DURATION_S = 0.5;
const MAX_DURATION_S = 5.0;
const DEFAULT_DURATION_S = 3.0;
const TIMESTAMP_END_BUFFER_S = 0.05;
const MAX_SFX = 8;

type SfxInput = {
  timestamp: number;
  type: string;
  description: string;
  duration_seconds?: number;
  prompt?: string;
};

type SfxResolved = {
  timestamp: number;
  type: string;
  description: string;
  duration_seconds: number;
  prompt: string | null;
};

function clampDuration(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_DURATION_S;
  if (value < MIN_DURATION_S) return MIN_DURATION_S;
  if (value > MAX_DURATION_S) return MAX_DURATION_S;
  return value;
}

function validateSfx(
  sfx: SfxInput[],
  duration: number | null,
): { resolved: SfxResolved[]; dropped: Array<{ entry: SfxInput; reason: string }> } {
  const resolved: SfxResolved[] = [];
  const dropped: Array<{ entry: SfxInput; reason: string }> = [];
  for (const entry of sfx) {
    if (!Number.isFinite(entry.timestamp) || entry.timestamp < 0) {
      dropped.push({ entry, reason: "timestamp must be >= 0" });
      continue;
    }
    if (duration !== null && entry.timestamp > duration - TIMESTAMP_END_BUFFER_S) {
      dropped.push({
        entry,
        reason: `timestamp ${entry.timestamp.toFixed(2)}s past duration ${duration.toFixed(2)}s`,
      });
      continue;
    }
    resolved.push({
      timestamp: entry.timestamp,
      type: entry.type,
      description: entry.description,
      duration_seconds: clampDuration(entry.duration_seconds),
      prompt: typeof entry.prompt === "string" && entry.prompt.length > 0 ? entry.prompt : null,
    });
  }
  return { resolved, dropped };
}

export function findApplySfxSourceFile(
  files: ArtifactManifestFile[],
): ArtifactManifestFile | null {
  return files.find((file) => file.name.toLowerCase() === "original.mp4")
    ?? findVideoFile(files);
}

export function applySfxDef(engine: Engine): ToolDef {
  return {
    name: "apply_sfx",
    description:
      "Generate sound effects via ElevenLabs text-to-sound-effects and mix them onto a video asset's audio track in-place. "
      + "Each entry yields one discrete SFX cue at `duration_seconds`, mixed at the given timestamp. "
      + "Re-runs process_video downstream. Pair with /suggest-sfx to source entries.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-*)"),
      book_id: z.string().describe("Book id"),
      sfx: z
        .array(
          z.object({
            timestamp: z.number().min(0).describe("Seconds into the video where the SFX starts"),
            type: z.string().describe("Short slug like 'whoosh', 'impact', 'ding'"),
            description: z.string().describe("One-sentence description for the generator"),
            duration_seconds: z.number().optional().describe(`SFX clip length (clamped to [${MIN_DURATION_S}, ${MAX_DURATION_S}], default ${DEFAULT_DURATION_S})`),
            prompt: z.string().optional().describe("Optional override sent to ElevenLabs verbatim. When set, overrides the auto-built `${type}: ${description}` prompt."),
          }),
        )
        .min(1)
        .max(MAX_SFX)
        .describe(`SFX placements. Up to ${MAX_SFX}.`),
    },
    handler: async (args) => {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "ELEVENLABS_API_KEY environment variable is not set" }],
        };
      }

      const { asset_id, book_id, sfx } = args as {
        asset_id: string;
        book_id: string;
        sfx: SfxInput[];
      };
      const assetId = asset_id.replace(/^@/, "");

      const manifestResult = await engine.files.manifest(assetId);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const manifest = manifestResult.value;
      const videoFile = findApplySfxSourceFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${assetId}` }],
        };
      }

      const metaResult = await engine.metadata.artifacts.read<{ duration?: number }>(assetId, "original"
      );
      const duration = metaResult.ok && typeof metaResult.value.duration === "number"
        ? metaResult.value.duration
        : null;

      const { resolved, dropped } = validateSfx(sfx, duration);
      if (resolved.length === 0) {
        const reasons = dropped.map((d) => d.reason).join("; ");
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `All SFX entries were rejected: ${reasons || "no valid entries"}`,
          }],
        };
      }

      const cleared = await engine.jobs.failures.clear(assetId);
      if (!cleared.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to clear the previous SFX error: ${cleared.error.message}`,
          }],
        };
      }

      const assetDir = manifest.path;
      const inputPath = join(assetDir, videoFile.name);
      const outputPath = join(assetDir, "original_sfx.mp4");
      const jobId = `apply-sfx-${assetId}-${Date.now()}`;

      try {
        await queue.enqueueAndWait(jobId, {
          type: "apply_sfx",
          videoPath: inputPath,
          outputPath,
          sfx: resolved,
          assetId,
          assetDir,
          bookId: book_id,
        }, 1_800_000);
      } catch (err) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Apply SFX failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: assetId,
            job_id: jobId,
            status: "completed",
            applied: resolved.length,
            dropped: dropped.length,
          }),
        }],
      };
    },
  };
}

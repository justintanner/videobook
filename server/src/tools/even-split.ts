import type { Artifact, Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

// Default first-chunk target for no-arg ad-hoc slicing. Caller can override
// via target_secs (e.g. [10] or [10, 15]) for tailored chunk lengths.
const DEFAULT_TARGET_SEC = 7;
// ffmpeg can't reliably produce a usable mp4 below this. Mirrors split-video.ts.
const MIN_CHUNK_SEC = 0.5;

export interface EvenSplitChunk {
  start: number;
  end: number;
  duration: number;
  /** True for chunks produced from a target length (need exact-second container). False for the trailing leftover. */
  exact: boolean;
}

export type PlanResult =
  | { ok: true; chunks: EvenSplitChunk[]; usedTargets: number[]; hasLeftover: boolean }
  | { ok: false; error: string };

/**
 * Slice the source into N+1 chunks: one chunk per target length, plus a
 * trailing "leftover" chunk holding whatever's left. Caller decides whether
 * to keep the leftover.
 *
 * Why a 1-second backup on the last target? Most gens accept 9s clips just
 * as readily as 10s, so when the targets sum would leave a sub-MIN tail,
 * dropping 1s from the last target is the cheapest way to still get
 * magic-sized targeted chunks.
 */
export function planEvenSplit(D: number, targets: number[]): PlanResult {
  if (!Number.isFinite(D) || D <= 0) {
    return { ok: false, error: "Invalid source duration." };
  }
  if (targets.length === 0) {
    return { ok: false, error: "At least one target_secs value is required." };
  }
  for (const t of targets) {
    if (!Number.isFinite(t) || t <= 0) {
      return { ok: false, error: `Invalid target_secs value: ${t}.` };
    }
  }

  // Build a plan if these targets are workable: sum must fit within D,
  // and the trailing leftover must be either exactly zero or ≥ MIN.
  const tryPlan = (
    ts: number[],
  ): { chunks: EvenSplitChunk[]; hasLeftover: boolean } | null => {
    const sum = ts.reduce((a, b) => a + b, 0);
    if (sum > D) return null;
    const leftover = D - sum;
    if (leftover > 0 && leftover < MIN_CHUNK_SEC) return null;
    const chunks: EvenSplitChunk[] = [];
    let cursor = 0;
    for (const t of ts) {
      chunks.push({ start: cursor, end: cursor + t, duration: t, exact: true });
      cursor += t;
    }
    const hasLeftover = leftover >= MIN_CHUNK_SEC;
    if (hasLeftover) {
      chunks.push({ start: cursor, end: D, duration: leftover, exact: false });
    }
    return { chunks, hasLeftover };
  };

  // Try targets as-is first.
  const direct = tryPlan(targets);
  if (direct) {
    return { ok: true, chunks: direct.chunks, usedTargets: targets, hasLeftover: direct.hasLeftover };
  }

  // Backup: knock 1s off the last target. Covers two failure modes:
  //   (a) last target overshoots D (e.g. D=9.5, [10] → [9])
  //   (b) sub-MIN tail (e.g. D=10.4, [10] → [9] with 1.4s leftover)
  const last = targets[targets.length - 1];
  if (last > 1) {
    const backed = [...targets.slice(0, -1), last - 1];
    const backedPlan = tryPlan(backed);
    if (backedPlan) {
      return {
        ok: true,
        chunks: backedPlan.chunks,
        usedTargets: backed,
        hasLeftover: backedPlan.hasLeftover,
      };
    }
  }

  const sum = targets.reduce((a, b) => a + b, 0);
  return {
    ok: false,
    error: `Source ${D.toFixed(2)}s is too short to split off targets [${targets.join(", ")}] (sum ${sum.toFixed(2)}s).`,
  };
}

function parseSingleTarget(input: number | string): number {
  if (typeof input === "number") return input;
  // Strip a trailing unit suffix like "s" / " sec" so "10s" parses cleanly.
  const stripped = input.trim().replace(/\s*s(ec(onds?)?)?$/i, "");
  return Number(stripped);
}

function parseTargetSecs(input: Array<number | string> | undefined): number[] {
  if (input === undefined || input.length === 0) return [DEFAULT_TARGET_SEC];
  return input.map(parseSingleTarget);
}

// Numeric suffixes "1".."N" mark chunk order; trim the source label to its
// last 2 words so labels stay short. Mirrors split-video.ts.
function deriveChunkName(source: Artifact, index: number): string {
  const base = source.label ?? source.artifactId;
  const words = base.split(/[\s-]+/u).filter((w) => w.length > 0);
  const tail = words.slice(-2).join("-") || base;
  return `${tail}-${index}`;
}

export function splitVideoByDurationsDef(engine: Engine): ToolDef {
  return {
    name: "split_video_by_durations",
    description:
      "Split a video into N targeted chunks plus a leftover chunk with the rest. Pass target_secs as a list (e.g. [10] or [10, 15]); each target produces an exact-length chunk, and the trailing leftover holds whatever's left. If the leftover would be sub-half-second, the last target is backed off by 1s. Source is preserved. When `destination` is provided, chunks are written as files inside an existing asset (one filename per target, no leftover) instead of minting fresh video assets.",
    schema: {
      asset_id: z.string().describe("Source video artifact id"),
      book_id: z.string().describe("Book UUID"),
      // Accept array of strings/numbers; chat positional args arrive as strings
      // (possibly with unit suffixes like "10s"), MCP clients typically pass numbers.
      target_secs: z
        .array(z.union([z.number(), z.string()]))
        .optional()
        .describe(
          "Ordered list of target chunk lengths in seconds (default [7]). Each entry accepts '7', '7s', or 7. A leftover chunk holds whatever's left after these.",
        ),
      destination: z
        .object({
          asset_id: z.string().describe("Existing artifact id to write chunk files into"),
          filenames: z.array(z.string()).describe("One filename per target_secs entry; written as siblings inside the destination asset's directory"),
        })
        .optional()
        .describe(
          "When set, write each chunk to <destination.asset_id>/<filenames[i]> instead of minting fresh video assets. filenames.length must equal target_secs.length; no leftover chunk is produced in destination mode.",
        ),
    },
    handler: async (args) => {
      const { asset_id, book_id, target_secs, destination } = args as {
        asset_id: string;
        book_id: string;
        target_secs?: Array<number | string>;
        destination?: { asset_id: string; filenames: string[] };
      };

      const targets = parseTargetSecs(target_secs);

      // Destination-mode arity: one filename per target, and no leftover —
      // the caller has named exactly which siblings to write inside the
      // destination asset. Reject early so we don't probe ffmpeg for nothing.
      if (destination !== undefined && destination.filenames.length !== targets.length) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `destination.filenames length (${destination.filenames.length}) must equal target_secs length (${targets.length})`,
          }],
        };
      }

      const sourceArtifact = engine.artifacts.get(asset_id);
      if (!sourceArtifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: sourceArtifact.error.message }],
        };
      }

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const sourcePath = join(manifest.path, videoFile.name);

      let sourceDurationSec: number;
      try {
        sourceDurationSec = (await probeVideo(sourcePath)).duration;
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to probe source duration: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      const plan = planEvenSplit(sourceDurationSec, targets);
      if (!plan.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: plan.error }],
        };
      }

      // Destination mode produces one output per target — no leftover —
      // because the caller declared the exact set of filenames to write.
      // The targets-only plan already enforces summing fits under D, so
      // hasLeftover signals "leftover would have spilled" and we refuse.
      if (destination !== undefined && plan.hasLeftover) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Destination mode does not support leftover chunks: targets sum to ${plan.usedTargets.reduce((a, b) => a + b, 0).toFixed(2)}s but source is ${sourceDurationSec.toFixed(2)}s`,
          }],
        };
      }

      let created: Array<{
        assetId: string;
        assetDir: string;
        outputPath: string;
        start: number;
        end: number;
        duration: number;
        exact: boolean;
      }>;
      let destinationMode = false;

      if (destination !== undefined) {
        destinationMode = true;
        const destManifest = await engine.files.manifest(destination.asset_id);
        if (!destManifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Destination asset ${destination.asset_id} not found: ${destManifest.error.message}` }],
          };
        }
        const existingNames = new Set(destManifest.value.files.map((f) => f.name));
        const collisions = destination.filenames.filter((n) => existingNames.has(n));
        if (collisions.length > 0) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Destination already contains: ${collisions.join(", ")}. Refusing silent overwrite.`,
            }],
          };
        }
        // In destination mode `plan.chunks` has exactly N entries (no leftover);
        // pair them with the caller's filenames positionally.
        created = plan.chunks.map((chunk, i) => ({
          assetId: destination.asset_id,
          assetDir: destManifest.value.path,
          outputPath: join(destManifest.value.path, destination.filenames[i]),
          start: chunk.start,
          end: chunk.end,
          duration: chunk.duration,
          exact: chunk.exact,
        }));
      } else {
        created = [];
        for (let i = 0; i < plan.chunks.length; i++) {
          const chunk = plan.chunks[i];
          const name = deriveChunkName(sourceArtifact.value, i + 1);
          const c = await engine.artifacts.create(sourceArtifact.value.kind, name);
          if (!c.ok) {
            return {
              isError: true as const,
              content: [{ type: "text" as const, text: `Failed to create chunk ${i + 1} asset: ${c.error.message}` }],
            };
          }
          created.push({
            assetId: c.value.artifactId,
            assetDir: c.value.path,
            outputPath: join(c.value.path, "original.mp4"),
            start: chunk.start,
            end: chunk.end,
            duration: chunk.duration,
            exact: chunk.exact,
          });
        }
      }

      const jobId = `even-split-${asset_id}-${Date.now()}`;
      // Fire-and-forget: the chunk assets/files were already created above, so
      // the UI can pick them up immediately. ffmpeg failures now surface via the
      // asset-work failed state like every other queued tool, not this response.
      await queue.enqueue(jobId, {
        type: "even_split",
        sourcePath,
        sourceAssetId: asset_id,
        chunks: created,
        bookId: book_id,
        destination: destinationMode ? { assetId: destination!.asset_id } : undefined,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            destinationMode
              ? {
                  source_asset_id: asset_id,
                  source_duration_sec: sourceDurationSec,
                  target_secs: targets,
                  used_target_secs: plan.usedTargets,
                  destination: {
                    asset_id: destination!.asset_id,
                    filenames: destination!.filenames,
                  },
                  job_id: jobId,
                  status: "enqueued",
                }
              : {
                  source_asset_id: asset_id,
                  source_duration_sec: sourceDurationSec,
                  target_secs: targets,
                  used_target_secs: plan.usedTargets,
                  has_leftover: plan.hasLeftover,
                  chunks: created.map((c) => ({
                    asset_id: c.assetId,
                    duration: c.duration,
                    exact: c.exact,
                  })),
                  job_id: jobId,
                  status: "enqueued",
                },
          ),
        }],
      };
    },
  };
}

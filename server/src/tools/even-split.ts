import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "clipfirst-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

// Default first-chunk target. 7s matches plan_visualization's MIN_SCENE_S
// so "split this for plan-vis" is still a sensible no-arg path. Caller can
// override via target_secs (e.g. [10] or [10, 15]) for ad-hoc slicing.
// plan-vis itself now passes per-scene durations explicitly (silence-aligned,
// 7–14s), so this default only governs ad-hoc CLI use.
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

// Suffixes "1".."N" survive slugifyName's stop-word filter; trim source name to
// last 2 words so the suffix fits inside the slug length cap. Mirrors split-video.ts.
function deriveChunkName(originalAssetId: string, index: number): string {
  const dashIdx = originalAssetId.indexOf("-");
  const base = dashIdx >= 0 ? originalAssetId.slice(dashIdx + 1) : originalAssetId;
  const words = base.split("-").filter((w) => w.length > 0);
  const tail = words.slice(-2).join("-") || base;
  return `${tail}-${index}`;
}

export function evenSplitDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "even_split",
    description:
      "Split a video into N targeted chunks plus a leftover chunk with the rest. Pass target_secs as a list (e.g. [10] or [10, 15]); each target produces an exact-length chunk, and the trailing leftover holds whatever's left. If the leftover would be sub-half-second, the last target is backed off by 1s. Source is preserved.",
    schema: {
      asset_id: z.string().describe("Source video asset ID (e.g. vid-my-clip)"),
      project_slug: z.string().describe("Project slug"),
      // Accept array of strings/numbers; chat positional args arrive as strings
      // (possibly with unit suffixes like "10s"), MCP clients typically pass numbers.
      target_secs: z
        .array(z.union([z.number(), z.string()]))
        .optional()
        .describe(
          "Ordered list of target chunk lengths in seconds (default [7]). Each entry accepts '7', '7s', or 7. A leftover chunk holds whatever's left after these. plan_visualization passes silence-aligned per-scene durations (7–14s) directly; this default only kicks in for ad-hoc CLI splits.",
        ),
    },
    handler: async (args) => {
      const { asset_id, project_slug, target_secs } = args as {
        asset_id: string;
        project_slug: string;
        target_secs?: Array<number | string>;
      };

      const targets = parseTargetSecs(target_secs);

      const manifestResult = await fs.getManifest(asset_id, project_slug);
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

      const prefix = asset_id.split("-")[0];
      const created: Array<{
        assetId: string;
        assetDir: string;
        outputPath: string;
        start: number;
        end: number;
        duration: number;
        exact: boolean;
      }> = [];
      for (let i = 0; i < plan.chunks.length; i++) {
        const chunk = plan.chunks[i];
        const name = deriveChunkName(asset_id, i + 1);
        const c = await fs.createAsset(prefix, name, project_slug);
        if (!c.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to create chunk ${i + 1} asset: ${c.error.message}` }],
          };
        }
        created.push({
          assetId: c.value.assetId,
          assetDir: c.value.path,
          outputPath: join(c.value.path, "original.mp4"),
          start: chunk.start,
          end: chunk.end,
          duration: chunk.duration,
          exact: chunk.exact,
        });
      }

      const jobId = `even-split-${asset_id}-${Date.now()}`;
      try {
        await queue.enqueueAndWait(jobId, {
          type: "even_split",
          sourcePath,
          sourceAssetId: asset_id,
          chunks: created,
          projectSlug: project_slug,
        });
      } catch (err) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Even-split failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
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
            status: "completed",
          }),
        }],
      };
    },
  };
}

export function registerEvenSplitTool(server: McpServer, fs: ClipfirstFs): void {
  const def = evenSplitDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}

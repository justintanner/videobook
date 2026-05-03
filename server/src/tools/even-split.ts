import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "clipfirst-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

// Default first-chunk target. Caller can override via target_sec.
const DEFAULT_TARGET_SEC = 10;
// ffmpeg can't reliably produce a usable mp4 below this. Mirrors split-video.ts.
const MIN_CHUNK_SEC = 0.5;

export interface EvenSplitChunk {
  start: number;
  end: number;
  duration: number;
}

export type PlanResult =
  | { ok: true; first: EvenSplitChunk; second: EvenSplitChunk; usedTarget: number }
  | { ok: false; error: string };

/**
 * Slice the source into exactly two chunks: first chunk == `target` seconds
 * (or `target - 1` if the remainder would be too tiny), second chunk is the
 * leftover. Caller decides whether to keep the leftover.
 *
 * Why a 1-second backup? Most gens accept 9s clips just as readily as 10s,
 * so when `target` would leave a sub-MIN tail, dropping 1s from the head is
 * the cheapest way to still get a magic-sized first chunk.
 */
export function planEvenSplit(D: number, target = DEFAULT_TARGET_SEC): PlanResult {
  if (!Number.isFinite(D) || D <= 0) {
    return { ok: false, error: "Invalid source duration." };
  }
  if (!Number.isFinite(target) || target <= 0) {
    return { ok: false, error: "Invalid target_sec." };
  }
  // Try exact target first.
  if (D - target >= MIN_CHUNK_SEC) {
    return {
      ok: true,
      first: { start: 0, end: target, duration: target },
      second: { start: target, end: D, duration: D - target },
      usedTarget: target,
    };
  }
  // Backup: target - 1 (e.g. 9s for the default 10s).
  const backup = target - 1;
  if (backup > 0 && D - backup >= MIN_CHUNK_SEC) {
    return {
      ok: true,
      first: { start: 0, end: backup, duration: backup },
      second: { start: backup, end: D, duration: D - backup },
      usedTarget: backup,
    };
  }
  return {
    ok: false,
    error: `Source ${D.toFixed(2)}s is too short to split off a ${target}s (or ${backup}s backup) first chunk.`,
  };
}

function parseTargetSec(input: number | string | undefined): number {
  if (input === undefined) return DEFAULT_TARGET_SEC;
  if (typeof input === "number") return input;
  // Strip a trailing unit suffix like "s" / " sec" so "10s" parses cleanly.
  const stripped = input.trim().replace(/\s*s(ec(onds?)?)?$/i, "");
  const n = Number(stripped);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TARGET_SEC;
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
      "Split a video at a magic-length mark: produces a first chunk of exactly target_sec (default 10s; falls back to target_sec - 1 if the leftover would be too tiny) and a second chunk with the rest. Source is preserved.",
    schema: {
      asset_id: z.string().describe("Source video asset ID (e.g. vid-my-clip)"),
      project_slug: z.string().describe("Project slug"),
      // Accept string OR number: chat positional args arrive as strings (e.g. "10s"
      // with a unit suffix), MCP clients typically pass a number.
      target_sec: z
        .union([z.number(), z.string()])
        .optional()
        .describe("First chunk length in seconds (default 10). Accepts '10', '10s', or 10."),
    },
    handler: async (args) => {
      const { asset_id, project_slug, target_sec } = args as {
        asset_id: string;
        project_slug: string;
        target_sec?: number | string;
      };

      const target = parseTargetSec(target_sec);

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

      const plan = planEvenSplit(sourceDurationSec, target);
      if (!plan.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: plan.error }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const created: Array<{ assetId: string; assetDir: string; outputPath: string; start: number; end: number; duration: number }> = [];
      for (let i = 0; i < 2; i++) {
        const chunk = i === 0 ? plan.first : plan.second;
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
            chunk_a_asset_id: created[0].assetId,
            chunk_b_asset_id: created[1].assetId,
            chunk_a_duration: created[0].duration,
            chunk_b_duration: created[1].duration,
            target_sec: target,
            used_first_chunk_sec: plan.usedTarget,
            source_duration_sec: sourceDurationSec,
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

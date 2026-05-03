import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "clipfirst-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

// Magic durations video gens accept exactly. Tried in priority order: a clean
// 10s split beats a clean 15s split, and both beat the equal-ish fallback.
const MAGIC_DURATIONS: readonly number[] = [10, 15];
// Cap each chunk at 10s in the fallback path — Wan 2.7 VideoEdit's hard limit.
const MAX_CHUNK_SEC = 10;
// Allow tiny rounding slack when checking magic divisibility against a probed
// (and therefore noisy) source duration.
const MAGIC_TOLERANCE_SEC = 0.1;

export interface EvenSplitChunk {
  start: number;
  end: number;
  duration: number;
}

/**
 * Plan how to slice a source of duration `D` (seconds) into N chunks for video
 * generators. Returns one chunk per output asset; cumulative `start`/`end`
 * cover the whole source. See plan file for the worked-examples table.
 */
export function planEvenSplit(D: number): EvenSplitChunk[] {
  if (!Number.isFinite(D) || D <= 0) return [];

  // Magic-divisor fast path: prefer 10s, then 15s.
  for (const m of MAGIC_DURATIONS) {
    const ratio = D / m;
    const N = Math.round(ratio);
    if (N >= 1 && Math.abs(D - N * m) < MAGIC_TOLERANCE_SEC) {
      return buildCumulative(distributeMagic(D, m, N));
    }
  }

  // Equal-ish integer fallback. Use floor(D) for the integer math; any
  // sub-second remainder is added back to the very last chunk so we don't
  // drop source content.
  const Dint = Math.floor(D);
  const N = Math.max(1, Math.ceil(D / MAX_CHUNK_SEC));
  const base = Math.floor(Dint / N);
  const extra = Dint - base * N;
  const lengths: number[] = [];
  for (let i = 0; i < extra; i++) lengths.push(base + 1);
  for (let i = 0; i < N - extra; i++) lengths.push(base);
  // Absorb the fractional tail (e.g. 35.4 - 35 = 0.4s) into the last chunk.
  const lengthSum = lengths.reduce((a, b) => a + b, 0);
  lengths[lengths.length - 1] += D - lengthSum;
  return buildCumulative(lengths);
}

function distributeMagic(D: number, m: number, N: number): number[] {
  const lengths = new Array<number>(N).fill(m);
  // Probed durations are noisy — fold any tiny over/undershoot into the tail
  // so cumulative ranges still cover the whole source exactly.
  const lengthSum = lengths.reduce((a, b) => a + b, 0);
  lengths[lengths.length - 1] += D - lengthSum;
  return lengths;
}

function buildCumulative(lengths: number[]): EvenSplitChunk[] {
  const out: EvenSplitChunk[] = [];
  let t = 0;
  for (const len of lengths) {
    out.push({ start: t, end: t + len, duration: len });
    t += len;
  }
  return out;
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
      "Split a video into N gen-friendly chunks. Prefers exact 10s or 15s chunks when the source duration divides cleanly; otherwise falls back to integer-second equal-ish chunks all ≤10s. Produces N new assets, source preserved.",
    schema: {
      asset_id: z.string().describe("Source video asset ID (e.g. vid-my-clip)"),
      project_slug: z.string().describe("Project slug"),
      // Accept string OR number: chat positional args arrive as strings (e.g. "10s"
      // with a unit suffix), MCP clients typically pass a number.
      target_sec: z
        .union([z.number(), z.string()])
        .optional()
        .describe("Preferred chunk length hint, advisory (e.g. 10 or '10s'). Default 10."),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as {
        asset_id: string;
        project_slug: string;
        target_sec?: number | string;
      };

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

      const plannedChunks = planEvenSplit(sourceDurationSec);
      if (plannedChunks.length < 2) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Source is ${sourceDurationSec.toFixed(2)}s; already short enough for video gens (≤${MAX_CHUNK_SEC}s). No split needed.`,
          }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const createdAssets: Array<{ assetId: string; assetDir: string; outputPath: string; start: number; end: number; duration: number }> = [];
      for (let i = 0; i < plannedChunks.length; i++) {
        const chunk = plannedChunks[i];
        const name = deriveChunkName(asset_id, i + 1);
        const created = await fs.createAsset(prefix, name, project_slug);
        if (!created.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to create chunk ${i + 1} asset: ${created.error.message}` }],
          };
        }
        createdAssets.push({
          assetId: created.value.assetId,
          assetDir: created.value.path,
          outputPath: join(created.value.path, "original.mp4"),
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
          chunks: createdAssets,
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
            chunk_asset_ids: createdAssets.map((c) => c.assetId),
            chunk_durations: createdAssets.map((c) => c.duration),
            chunk_count: createdAssets.length,
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

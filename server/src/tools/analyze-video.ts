import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import {
  PLAIN_TRANSCRIPT_FILE,
  TIMED_TRANSCRIPT_FILE,
} from "../transcript-projection.js";
import {
  isAnalyzableVideo,
  VIDEO_ANALYSIS_FILE,
} from "../video-analysis-projection.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export async function analyzeVideoJobPayload(engine: Engine, assetId: string, bookId: string, purpose?: "tagging"): Promise<Record<string, unknown>> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const [timed, plain] = await Promise.all([
    engine.files.read(assetId, TIMED_TRANSCRIPT_FILE),
    engine.files.read(assetId, PLAIN_TRANSCRIPT_FILE),
  ]);
  return {
    type: "analyze_video",
    assetId,
    assetDir: manifest.value.path,
    bookId,
    hasTranscription: timed.ok || plain.ok,
    ...(purpose ? { purpose } : {}),
  };
}

export function analyzeVideoDef(engine: Engine): ToolDef {
  return {
    name: "analyze_video",
    description:
      "Analyze a video asset with vision: samples frames, folds in the transcript when one exists, and writes .original.analysis.json (summary, scenes, tags, subjects, burned-in subtitle and watermark detection). Returns as soon as the job is enqueued; the analysis appears on the asset once the job completes.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book UUID"),
      force: z.boolean().optional().default(false)
        .describe("Re-analyze even when the asset already has an analysis"),
    },
    handler: async (args) => {
      const { asset_id, book_id, force } = args as {
        asset_id: string;
        book_id: string;
        force: boolean;
      };

      if (!process.env.OPENAI_API_KEY) return error("OPENAI_API_KEY is not set");

      const artifact = engine.artifacts.get(asset_id);
      if (!artifact.ok) return error(artifact.error.message);
      if (!isAnalyzableVideo(artifact.value.kind)) {
        return error(
          `analyze_video only accepts video artifacts, got ${artifact.value.kind} artifact ${asset_id}`,
        );
      }

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) return error(manifestResult.error.message);

      if (!force && (await engine.files.read(asset_id, VIDEO_ANALYSIS_FILE)).ok) {
        return ok({ asset_id, status: "already_analyzed" });
      }

      // Stable dedupe key: repeated clicks collapse onto one queued job, and the
      // partial unique index only covers active states so a later re-analysis
      // still enqueues.
      const jobId = `analyze-video-${asset_id}`;
      await queue.enqueue(jobId, await analyzeVideoJobPayload(engine, asset_id, book_id));

      return ok({ asset_id, job_id: jobId, status: "enqueued" });
    },
  };
}

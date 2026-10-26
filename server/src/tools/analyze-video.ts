import type { Engine } from "videobook-engine";
import { z } from "zod";
import { requestSidecarAnalysis, sidecarAnalysisNeedsRun } from "../analysis-sidecars.js";
import { VIDEO_ANALYSIS, videoAnalysisInputs, videoAnalysisRecord } from "../vision-components.js";
import {
  PLAIN_TRANSCRIPT_FILE,
  TIMED_TRANSCRIPT_FILE,
} from "../transcript-projection.js";
import { isAnalyzableVideo } from "../video-analysis-projection.js";
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
      "Analyze a video with vision and its transcript in a background job: summary, scenes, tags, subjects, and burned-in subtitles or watermarks. The analysis appears on the asset when the job finishes. Returns status cached when the current video and transcript were already analysed; a repeated or concurrent request joins the running job.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book UUID"),
      force: z.boolean().optional().default(false)
        .describe("Re-analyze even when the current video and transcript were already analysed"),
    },
    handler: async (args) => {
      const { asset_id, book_id, force } = args as {
        asset_id: string;
        book_id: string;
        force: boolean;
      };

      const artifact = engine.artifacts.get(asset_id);
      if (!artifact.ok) return error(artifact.error.message);
      if (!isAnalyzableVideo(artifact.value.kind)) {
        return error(
          `analyze_video only accepts video artifacts, got ${artifact.value.kind} artifact ${asset_id}`,
        );
      }

      const manifest = await engine.files.manifest(asset_id);
      if (!manifest.ok) return error(manifest.error.message);
      const payload = await analyzeVideoJobPayload(engine, asset_id, book_id);
      const inputs = await videoAnalysisInputs(engine, asset_id, payload.hasTranscription === true);
      if (!inputs) {
        return error(
          `${asset_id} has no video file yet; wait for its generation or processing to finish before analyzing it`,
        );
      }

      const record = videoAnalysisRecord(engine, asset_id, inputs);
      if (!process.env.OPENAI_API_KEY && await sidecarAnalysisNeedsRun(engine, VIDEO_ANALYSIS, { ...record, force })) {
        return error("OPENAI_API_KEY is not set");
      }
      const requested = await requestSidecarAnalysis(engine, VIDEO_ANALYSIS, { ...record, force, payload: { ...payload, bookId: book_id } });
      return ok({ asset_id, job_id: requested.jobId, status: requested.status });
    },
  };
}

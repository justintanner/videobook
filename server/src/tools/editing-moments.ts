import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { findPrimaryMediaFile } from "videobook-engine";
import {
  MOMENTS_MAX_SCAN_SECONDS,
  MOMENTS_MIN_MOMENT_SECONDS,
  editingMomentsId,
  readEditingMoments,
} from "../editing-moments.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

const readSchema = z.object({ book_id: z.string().uuid(), asset_id: z.string().uuid() });
const analyzeSchema = readSchema.extend({
  start_seconds: z.number().nonnegative().optional(),
  end_seconds: z.number().positive().optional(),
  force: z.boolean().optional(),
});

export function editingMomentsDefs(engine: Engine): ToolDef[] {
  const schema = { book_id: z.string().uuid(), asset_id: z.string().uuid() };
  return [
    {
      name: "analyze_editing_moments",
      description: "Analyze footage for editing in a background job: shot boundaries, per-shot motion, subject changes, usable ranges and ranked source moments, reused for unchanged sources. Read the results with get_editing_moments.",
      scope: "book",
      schema: {
        ...schema,
        start_seconds: z.number().nonnegative().optional(),
        end_seconds: z.number().positive().optional(),
        force: z.boolean().optional(),
      },
      handler: async (input) => {
        try {
          const args = analyzeSchema.parse(input);
          const source = await momentsSource(engine, args.asset_id, {
            startSeconds: args.start_seconds, endSeconds: args.end_seconds,
          });
          if (!args.force && await readEditingMoments(engine, args.asset_id, source.momentsId)) {
            return json(await readState(engine, args.asset_id, args.start_seconds, args.end_seconds));
          }
          await queue.enqueue(`editing-moments-${source.momentsId}`, {
            type: "analyze_editing_moments", bookId: args.book_id, assetId: args.asset_id,
            startSeconds: source.startSeconds, endSeconds: source.endSeconds,
          });
          return json(await readState(engine, args.asset_id, args.start_seconds, args.end_seconds));
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "get_editing_moments",
      description: "Read cached editing moments (shot boundaries, motion, ranked source moments) for the current video source",
      scope: "book", schema,
      handler: async (args) => {
        try {
          return json(await readState(engine, String(args.asset_id)));
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}

async function momentsSource(engine: Engine, artifactId: string, args: { startSeconds?: number; endSeconds?: number } = {}) {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok) throw new Error(artifact.error.message);
  if (!["video", "final"].includes(artifact.value.kind)) throw new Error("Choose a video source to analyze");
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const stream = streams.value.find((item) => item.kind === "video" && item.sourcePath === file?.name
    && item.objectHash === file?.objectHash);
  if (!stream || !file) throw new Error("Wait for the current video source to finish processing");
  const durationSeconds = stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator;
  if (!(durationSeconds > 0) || durationSeconds > MOMENTS_MAX_SCAN_SECONDS) {
    throw new Error(`Moment analysis supports video up to ${MOMENTS_MAX_SCAN_SECONDS / 60} minutes`);
  }
  const startSeconds = Math.min(Math.max(0, args.startSeconds ?? 0), Math.max(0, durationSeconds - MOMENTS_MIN_MOMENT_SECONDS));
  const endSeconds = args.endSeconds === undefined ? durationSeconds : Math.min(Math.max(startSeconds + MOMENTS_MIN_MOMENT_SECONDS, args.endSeconds), durationSeconds);
  const momentsId = editingMomentsId({ objectHash: stream.objectHash, streamIndex: stream.streamIndex, startSeconds, endSeconds });
  return { momentsId, startSeconds, endSeconds };
}

async function readState(engine: Engine, artifactId: string, startSeconds?: number, endSeconds?: number) {
  const source = await momentsSource(engine, artifactId, { startSeconds, endSeconds });
  const cached = await readEditingMoments(engine, artifactId, source.momentsId);
  const jobs = engine.jobs.queue.list({ type: "analyze_editing_moments", limit: 500 });
  const job = jobs.filter((item) => item.payload.assetId === artifactId)
    .sort((left, right) => right.id - left.id)[0];
  const pending = job && ["queued", "running", "completing"].includes(job.state);
  const status = cached ? "ready"
    : pending ? job!.state === "queued" ? "queued" : "analyzing"
      : job?.state === "aborted" ? "cancelled" : job?.state === "failed" ? "failed" : "missing";
  return {
    status, momentsId: source.momentsId, jobId: job?.id ?? null,
    error: job?.error?.message ?? null, moments: cached,
  };
}

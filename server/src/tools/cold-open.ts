import { createHash, randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import { checkColdOpenNotebook, coldOpenCacheKey, coldOpenSource, readColdOpenSuggestion } from "../cold-open.js";
import { coldOpenRangeError } from "../cold-open-model.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { resolveVideoAssetReference } from "./video-source-reference.js";
import { parseVideoTimestamp, videoTimestampSchema } from "./video-time-input.js";

const sourceSchema = z.object({
  book_id: z.string().uuid(),
  asset_id: z.string().min(1).describe("Source video artifact UUID or notebook address such as @a1"),
  notebook_id: z.string().uuid().optional(),
});
const editSchema = sourceSchema.extend({
  source_object_hash: z.string().min(1).describe("Source hash returned by prepare_cold_open"),
  start_time: videoTimestampSchema,
  end_time: videoTimestampSchema,
  request_id: z.string().uuid().describe("Stable request UUID; reuse when retrying this exact reviewed edit"),
});

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });

export function coldOpenDefs(engine: Engine): ToolDef[] {
  return [{
    name: "prepare_cold_open",
    description: "Select an exciting 2–5 second video highlight with AI for a cold-open copy. Start here when asked for a cold open: review and adjust the returned range before calling edit_cold_open. Returns a cached suggestion or an analysis job ID; read its result with list_jobs. Does not create a video copy.",
    schema: sourceSchema.shape,
    handler: async (input) => {
      try {
        const args = sourceSchema.parse(input);
        const sourceId = resolveVideoAssetReference(engine, args.asset_id, args.notebook_id);
        checkColdOpenNotebook(engine, args.notebook_id, sourceId);
        return await withNotebookMutation(`cold-open-prepare:${args.book_id}:${sourceId}`, async () => {
          const source = await coldOpenSource(engine, sourceId);
          const cacheKey = coldOpenCacheKey(source);
          const cached = readColdOpenSuggestion(engine, cacheKey);
          if (cached) return json({ status: "ready", suggestion: cached });
          const pending = engine.jobs.queue.list({ type: "prepare_cold_open", limit: 500 })
            .find(job => job.payload.cacheKey === cacheKey && ["queued", "running", "completing"].includes(job.state));
          if (pending) return json({ status: "queued", job_id: pending.id });
          if (!getApiKey("OPENAI_API_KEY")) throw new Error("Set OPENAI_API_KEY in provider settings to select a cold-open highlight.");
          const job = await queue.enqueue(`cold-open-prepare-${cacheKey}-${randomUUID()}`, {
            type: "prepare_cold_open", bookId: args.book_id, sourceArtifactId: sourceId,
            sourceObjectHash: source.file.objectHash, cacheKey,
          });
          return json({ status: "queued", job_id: job.id });
        });
      } catch (error) { return failure(error); }
    },
  }, {
    name: "edit_cold_open",
    description: "Create a new cold-open video copy from a reviewed highlight: selected source range, hard cut, then the complete original clip. Requires a suggestion from prepare_cold_open and the user's reviewed start/end times. Preserves the source. Poll list_jobs for the output artifact and notebook cell.",
    annotations: { destructiveHint: false, readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    schema: editSchema.shape,
    handler: async (input) => {
      try {
        const args = editSchema.parse(input);
        const sourceId = resolveVideoAssetReference(engine, args.asset_id, args.notebook_id);
        const start = parseVideoTimestamp(args.start_time, "start_time")!;
        const end = parseVideoTimestamp(args.end_time, "end_time")!;
        const fingerprint = createHash("sha256").update(JSON.stringify([sourceId, args.notebook_id, args.source_object_hash, start, end])).digest("hex");
        return await withNotebookMutation(`cold-open:${args.book_id}:${args.request_id}`, async () => {
          const key = `cold-open.request.${args.request_id}`;
          const existing = engine.settings.get<{ fingerprint: string; artifactId: string; jobId?: number }>(key);
          if (existing && existing.fingerprint !== fingerprint) throw new Error("This request ID belongs to a different edit. Start a new request.");
          if (existing && !engine.artifacts.get(existing.artifactId).ok) throw new Error("The cold-open copy was deleted. Start a new request.");
          const previous = existing?.jobId ? engine.jobs.queue.get(existing.jobId)
            : engine.jobs.queue.list({ type: "edit_cold_open", limit: 500 }).find(job => job.payload.requestId === args.request_id);
          if (previous && ["queued", "running", "completing", "done"].includes(previous.state)) {
            return json({ status: previous.state === "done" ? "completed" : "queued", job_id: previous.id, output_asset_id: existing?.artifactId });
          }
          const source = await coldOpenSource(engine, sourceId, args.source_object_hash);
          const rangeError = coldOpenRangeError(start, end, source.durationSeconds);
          if (rangeError) throw new Error(rangeError);
          checkColdOpenNotebook(engine, args.notebook_id, sourceId);
          let artifactId = existing?.artifactId;
          if (!artifactId) {
            const created = await engine.artifacts.create({ kind: "video", label: `${source.artifact.label ?? "Video"} — Cold open` });
            if (!created.ok) throw new Error(created.error.message);
            artifactId = created.value.artifactId;
            const stored = engine.settings.set(key, { fingerprint, artifactId });
            if (!stored.ok) {
              await engine.artifacts.delete(artifactId);
              throw new Error(stored.error.message);
            }
          }
          const job = await queue.enqueue(`cold-open-edit-${args.request_id}-${randomUUID()}`, {
            type: "edit_cold_open", bookId: args.book_id, assetId: artifactId,
            sourceArtifactId: sourceId, sourceObjectHash: args.source_object_hash,
            startSeconds: start, endSeconds: end, notebookId: args.notebook_id ?? null,
            requestId: args.request_id,
          });
          const stored = engine.settings.set(key, { fingerprint, artifactId, jobId: job.id });
          if (!stored.ok) throw new Error(stored.error.message);
          return json({ status: "queued", job_id: job.id, output_asset_id: artifactId });
        });
      } catch (error) { return failure(error); }
    },
  }];
}

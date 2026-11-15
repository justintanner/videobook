import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { withBookContext } from "../book-context.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { setEngineRoot, stopBookQueue, waitForJob } from "../queue.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { testBudget } from "../test-budget.js";
import { materializeVideoFixture } from "../test-media-fixtures.js";
import { chatActionPlanSchema, chatDef, prepareVoiceChatAction } from "./chat.js";
import type { ToolResult } from "./tool-def.js";

function resultValue(result: ToolResult): unknown {
  if (result.isError) throw new Error(result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

describe("chat full-clip downloads", () => {
  let root: string;
  let engine: Engine;
  let server: Server;
  let source: Buffer;
  let url: string;
  let bookId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-chat-download-"));
    engine = createEngineForTest(root);
    await engine.ready;
    bookId = engine.book.get().bookId;
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
    source = await readFile(await materializeVideoFixture({ width: 64, height: 64, durationSec: 4, fps: 10, source: "color", audio: false }));
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "video/mp4", "content-length": source.byteLength });
      response.end(source);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Video server has no port");
    url = `http://127.0.0.1:${address.port}/clip.mp4?t=1`;
  });

  afterAll(async () => {
    if (bookId) await stopBookQueue(bookId);
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("auto-applies a download and preserves the complete source despite routed or saved range settings", async () => {
    const input = { book_id: bookId, prompt: `Download ${url}` };
    const routed = await withBookContext({ bookId, engine }, () => prepareVoiceChatAction(engine, input, {
      tool: "download_video",
      params: { url, start_time: 1, end_time: 2, full: false, export_videos: true },
      message: "Downloading video.",
    }));
    const plan = chatActionPlanSchema.parse(resultValue(routed));
    expect(plan.confirmation.required).toBe(false);
    expect(plan.params).not.toHaveProperty("start_time");
    expect(plan.params).not.toHaveProperty("end_time");
    const applied = await withBookContext({ bookId, engine }, () => chatDef(engine).handler({
      book_id: bookId,
      action_plan: { ...plan, params: { ...plan.params, start_time: 1, end_time: 2, export_videos: true } },
    }));
    const download = z.object({ artifact_id: z.string(), job_id: z.string(), status: z.literal("enqueued") }).parse(resultValue(applied));
    const job = engine.jobs.queue.list({ type: "download_video", artifactId: download.artifact_id })[0]!;
    expect(job.payload).toMatchObject({ url, full: true, exportVideos: false });
    expect(job.payload).not.toHaveProperty("requestedRange");
    await waitForJob(download.job_id, testBudget(60_000));
    const original = await engine.files.read(download.artifact_id, "original.mp4");
    if (!original.ok) throw new Error(original.error.message);
    expect(original.value.equals(source)).toBe(true);
  }, testBudget(90_000));
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutoEditAnalyzeResponse, AutoEditGetResponse } from "../auto-edit/drafts.js";
import { DEFAULT_AUTO_EDIT_SECTIONS } from "../auto-edit/style.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);

interface TextContentItem {
  type: string;
  text: string;
}

function responsesBody(text: string, responseId: string): string {
  return JSON.stringify({
    id: responseId,
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-5.6-sol",
    output: [{
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    instructions: null,
    previous_response_id: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    store: false,
    tools: [],
    reasoning: null,
    text: { format: { type: "text" } },
    usage: { input_tokens: 150, output_tokens: 75, total_tokens: 225 },
    error: null,
    incomplete_details: null,
    metadata: {},
  });
}

describe("auto_edit analyze tool", () => {
  let fixtureRoot = "";
  let tempDir = "";
  let client: Client;
  let engine: Engine;
  let bookId = "";
  let assetId = "";
  let notebookId = "";
  let server: Server;
  let calls = 0;
  let restoreEndpoints: () => void = () => undefined;
  let savedOpenAiKey: string | undefined;

  async function callAutoEdit(args: Record<string, unknown>) {
    const result = await client.callTool({
      name: "auto_edit",
      arguments: { book_id: bookId, asset_id: "@a1", notebook_id: notebookId, ...args },
    });
    const text = (result.content as TextContentItem[])[0]!.text;
    return { isError: result.isError === true, text, body: JSON.parse(text) as unknown };
  }

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "auto-edit-analyze-tool-fixtures-"));
    await execFileAsync(FFMPEG, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p",
      "-an", join(fixtureRoot, "clip6s.mp4"),
    ], { timeout: testBudget(60_000) });

    server = createServer((_req, res) => {
      calls += 1;
      const start = calls === 1 ? 3.0 : 2.5;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responsesBody(JSON.stringify({
        moment: { start, peak: start + 0.5, end: start + 1.2 },
        focus: {
          start: { x: 0.4, y: 0.5 },
          peak: { x: 0.5, y: 0.5 },
          end: { x: 0.6, y: 0.5 },
        },
        hook: { start: 0.5, end: 2.2 },
        keep: { start: 0, end: 6 },
        cuts: [],
        summary: `Pass ${calls} summary.`,
        confidence: "high",
      }), `resp_auto_edit_tool_${calls}`));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }, testBudget(60_000));

  beforeEach(async () => {
    calls = 0;
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-auto-edit-tool-key";
    restoreEndpoints = configureProviderEndpoints({
      openaiBaseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });

    tempDir = await mkdtemp(join(tmpdir(), "auto-edit-analyze-tool-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = "auto-edit-analyze-book";
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });

    const created = await engine.artifacts.create({ kind: "video", label: "Clip" });
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
    const clipPath = join(fixtureRoot, "clip6s.mp4");
    await engine.files.writeFromPath(assetId, "original.mp4", clipPath);
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));

    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await engine.notebooks.insertCell(
      notebookId,
      engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId }),
    );
  });

  afterEach(async () => {
    await queue.stop();
    restoreEndpoints();
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("caches repeated analyze calls, supports force, preserves section switches, and records usage", async () => {
    const initial = (await callAutoEdit({ op: "get" })).body as AutoEditGetResponse;
    expect(initial.analysis).toEqual({
      status: "none",
      job_id: null,
      summary: null,
      confidence: null,
      error: null,
    });

    // Save custom section switches via render first; verify they survive analyze.
    const firstRender = await callAutoEdit({
      op: "render",
      source_hash: initial.source.source_hash,
      request_id: randomUUID(),
      sections: { ...DEFAULT_AUTO_EDIT_SECTIONS, coldOpen: false, crash: false },
    });
    expect(firstRender.isError).toBe(false);
    const renderJobId = (firstRender.body as { job_id: number }).job_id;
    await expect.poll(() => engine.jobs.queue.get(renderJobId)?.state, { timeout: testBudget(60_000) }).toBe("done");

    const [a1, a2] = await Promise.all([
      callAutoEdit({ op: "analyze" }),
      callAutoEdit({ op: "analyze" }),
    ]);
    expect(a1.isError).toBe(false);
    expect(a2.isError).toBe(false);
    const first = a1.body as { status: string; job_id: number };
    const second = a2.body as { status: string; job_id: number };
    expect(first.status).toMatch(/queued|running/);
    expect(second.job_id).toBe(first.job_id);

    await expect.poll(() => engine.jobs.queue.get(first.job_id)?.state, { timeout: testBudget(60_000) }).toBe("done");
    expect(calls).toBe(1);

    const afterAnalyze = (await callAutoEdit({ op: "get" })).body as AutoEditGetResponse;
    expect(afterAnalyze.draft.sections).toEqual({ ...DEFAULT_AUTO_EDIT_SECTIONS, coldOpen: false, crash: false });
    expect(afterAnalyze.draft.anchors.moment.start).toBeCloseTo(3.0, 1);

    // Second analyze hits cache with zero provider calls.
    const cached = (await callAutoEdit({ op: "analyze" })).body as AutoEditAnalyzeResponse;
    expect(cached).toMatchObject({
      status: "cached",
      analysis: { status: "ready", summary: "Pass 1 summary.", confidence: "high" },
    });
    expect(calls).toBe(1);

    // Force triggers a new request.
    const forced = (await callAutoEdit({ op: "analyze", force: true })).body as { status: string; job_id: number };
    expect(forced.status).toMatch(/queued|running/);
    expect(forced.job_id).not.toBe(first.job_id);
    await expect.poll(() => engine.jobs.queue.get(forced.job_id)?.state, { timeout: testBudget(60_000) }).toBe("done");
    expect(calls).toBe(2);

    const afterForce = (await callAutoEdit({ op: "get" })).body as AutoEditGetResponse;
    expect(afterForce.draft.anchors.moment.start).toBeCloseTo(2.5, 1);
    expect(afterForce.draft.sections).toEqual({ ...DEFAULT_AUTO_EDIT_SECTIONS, coldOpen: false, crash: false });

    // Book usage reflects the OpenAI /responses calls.
    const usageResult = await client.callTool({ name: "get_book_usage", arguments: { book_id: bookId } });
    expect(usageResult.isError).toBeFalsy();
    const usage = JSON.parse((usageResult.content as TextContentItem[])[0]!.text) as {
      recent: Array<{ provider: string; model?: string; operation?: string | null }>;
      totals: { count: number };
    };
    expect(usage.totals.count).toBeGreaterThanOrEqual(2);
    expect(usage.recent.filter((entry) => entry.provider === "openai")).toHaveLength(2);
    expect(usage.recent.some((entry) => entry.operation === "analyze_auto_edit")).toBe(true);
  }, testBudget(120_000));

  it("refuses analyze without an OpenAI key and keeps get and render working", async () => {
    delete process.env.OPENAI_API_KEY;

    const failed = await callAutoEdit({ op: "analyze" });
    expect(failed.isError).toBe(true);
    expect(failed.body).toMatchObject({
      status: "not_ready",
      message: expect.stringMatching(/Find the moment.*by hand/u),
    });
    expect(calls).toBe(0);
    expect(engine.jobs.queue.list({ type: "analyze_auto_edit", limit: 20 })).toEqual([]);

    const got = await callAutoEdit({ op: "get" });
    expect(got.isError).toBe(false);
    const getBody = got.body as AutoEditGetResponse;

    const rendered = await callAutoEdit({
      op: "render",
      source_hash: getBody.source.source_hash,
      request_id: randomUUID(),
    });
    expect(rendered.isError).toBe(false);
    const renderJobId = (rendered.body as { job_id: number }).job_id;
    await expect.poll(() => engine.jobs.queue.get(renderJobId)?.state, { timeout: testBudget(60_000) }).toBe("done");
  }, testBudget(90_000));
});

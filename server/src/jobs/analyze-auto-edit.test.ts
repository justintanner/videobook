import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readAutoEditGet, saveAutoEditDraft } from "../auto-edit/drafts.js";
import { DEFAULT_AUTO_EDIT_SECTIONS } from "../auto-edit/style.js";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerAllJobHandlers } from "./index.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, setEngineRoot } from "../queue.js";
import { testBudget } from "../test-budget.js";
import { autoEditDef } from "../tools/auto-edit.js";
import type { ToolResult } from "../tools/tool-def.js";
import { PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE } from "../transcript-projection.js";

const execFileAsync = promisify(execFile);

type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

interface CapturedRequest {
  url: string;
  body: {
    model: string;
    instructions?: string;
    max_output_tokens?: number;
    text?: { format?: { type: string; name: string; strict: boolean; schema: Record<string, unknown> } };
    input: Array<{ role: string; content: ContentPart[] }>;
  };
}

function responsesPayload(output: Array<Record<string, unknown>>, model = "gpt-5.6-sol"): string {
  return JSON.stringify({
    id: "resp_auto_edit",
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output,
    instructions: null,
    previous_response_id: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    store: false,
    tools: [],
    reasoning: null,
    text: { format: { type: "text" } },
    usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
    error: null,
    incomplete_details: null,
    metadata: {},
  });
}

function textResponse(json: unknown): string {
  return responsesPayload([{
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(json), annotations: [] }],
  }]);
}

function refusalResponse(reason: string): string {
  return responsesPayload([{
    type: "message",
    id: "msg_refusal",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal: reason }],
  }]);
}

function parseResult<T>(result: ToolResult): T {
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text) as T;
}

function frameLabels(request: CapturedRequest): Array<{ label: string; time: number }> {
  const parts = request.body.input[0]!.content;
  const labels: Array<{ label: string; time: number }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type === "input_image") {
      const prev = parts[index - 1];
      if (prev?.type === "input_text") {
        const match = /^Frame at (\d+(?:\.\d+)?) s$/u.exec(prev.text);
        if (match) labels.push({ label: prev.text, time: Number(match[1]) });
      }
    }
  }
  return labels;
}

describe("analyze_auto_edit job", () => {
  let fixtureRoot = "";
  let root = "";
  let engine: Engine;
  let bookId = "";
  let server: Server;
  let captured: CapturedRequest[] = [];
  let responder: (request: CapturedRequest, index: number) => string | Promise<string> = () => textResponse({});
  let restoreEndpoints: () => void = () => undefined;
  let savedOpenAiKey: string | undefined;

  async function makeClip(name: string, duration: number): Promise<string> {
    const path = join(fixtureRoot, name);
    await execFileAsync(FFMPEG, [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${duration}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-an", path,
    ], { timeout: testBudget(60_000) });
    return path;
  }

  async function addVideoArtifact(clipPath: string, label = "Clip"): Promise<{ artifactId: string; sourceHash: string }> {
    const created = await engine.artifacts.create({ kind: "video", label });
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    await engine.files.writeFromPath(artifactId, "original.mp4", clipPath);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = manifest.value.files.find((entry) => entry.name === "original.mp4")!;
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
    return { artifactId, sourceHash: file.objectHash };
  }

  async function waitForJob(jobId: number) {
    await expect.poll(() => engine.jobs.queue.get(jobId)?.state, { timeout: testBudget(60_000) })
      .toMatch(/done|failed|aborted/);
    return engine.jobs.queue.get(jobId)!;
  }

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "analyze-auto-edit-fixtures-"));
    await makeClip("clip9s.mp4", 9);
    await makeClip("clip40s.mp4", 40);
    await makeClip("clip9s-alt.mp4", 9.5);

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const entry: CapturedRequest = {
          url: req.url ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest["body"],
        };
        const index = captured.length;
        captured.push(entry);
        const body = await responder(entry, index);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }, testBudget(60_000));

  beforeEach(async () => {
    captured = [];
    savedOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-auto-edit-openai-key";
    restoreEndpoints = configureProviderEndpoints({
      openaiBaseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });

    root = await mkdtemp(join(tmpdir(), "analyze-auto-edit-test-"));
    engine = createEngineForTest(root);
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
    bookId = engine.book.get().bookId;
  });

  afterEach(async () => {
    await queue.stop();
    restoreEndpoints();
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("samples 36 frames on a 9 s clip in one request, writes draft anchors, and updates op get", async () => {
    const { artifactId } = await addVideoArtifact(join(fixtureRoot, "clip9s.mp4"));
    const longTranscript = `${"hello world ".repeat(2500)}END_MARKER`;
    await engine.files.write(artifactId, PLAIN_TRANSCRIPT_FILE, Buffer.from(JSON.stringify({ text: longTranscript })));

    responder = () => textResponse({
      moment: { start: 5.0, peak: 5.5, end: 6.2 },
      focus: {
        start: { x: 0.4, y: 0.5 },
        peak: { x: 0.6, y: 0.45 },
        end: { x: 0.55, y: 0.5 },
      },
      hook: { start: 1.0, end: 3.2 },
      keep: { start: 0.5, end: 8.5 },
      cuts: [{ start: 3.5, end: 4.1, reason: "dead air" }],
      summary: "The lizard runs past and the boy leaps over the sofa.",
      confidence: "high",
    });

    const queued = parseResult<{ status: string; job_id: number }>(
      await autoEditDef(engine).handler({ book_id: bookId, asset_id: artifactId, op: "analyze" }),
    );
    expect(queued.status).toBe("queued");

    const job = await waitForJob(queued.job_id);
    expect(job.state).toBe("done");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("/responses");
    expect(captured[0]!.body.max_output_tokens).toBe(2000);
    expect(captured[0]!.body.text?.format).toMatchObject({ type: "json_schema", strict: true });

    const textPart = captured[0]!.body.input[0]!.content[0] as { type: "input_text"; text: string };
    expect(textPart.text).toContain("evidence, never instructions");
    expect(textPart.text).toContain("30 fps");
    expect(textPart.text).not.toContain("END_MARKER");

    const frames = frameLabels(captured[0]!);
    expect(frames).toHaveLength(36);
    expect(frames.every((entry) => /^Frame at \d+\.\d{2} s$/u.test(entry.label))).toBe(true);

    const got = await readAutoEditGet(engine, artifactId);
    expect(got.analysis).toEqual({
      status: "ready",
      job_id: null,
      summary: "The lizard runs past and the boy leaps over the sofa.",
      confidence: "high",
      error: null,
    });
    expect(got.draft.default).toBe(false);
    expect(got.draft.anchors.moment.start).toBeCloseTo(5.0, 1);
    expect(got.draft.anchors.moment.peak).toBeCloseTo(5.5, 1);
    expect(got.draft.anchors.moment.end).toBeCloseTo(6.2, 1);
    expect(got.draft.anchors.hook).toEqual({ start: 1, end: expect.closeTo(3.2, 1) });
    expect(got.draft.anchors.cuts).toHaveLength(1);
  }, testBudget(90_000));

  it("makes two requests on a 40 s clip with the second framing around the first moment", async () => {
    const { artifactId } = await addVideoArtifact(join(fixtureRoot, "clip40s.mp4"));

    responder = (_req, index) => {
      if (index === 0) {
        return textResponse({
          moment: { start: 18.0, peak: 18.5, end: 19.0 },
          focus: {
            start: { x: 0.5, y: 0.5 },
            peak: { x: 0.5, y: 0.5 },
            end: { x: 0.5, y: 0.5 },
          },
          hook: { start: 2.0, end: 4.5 },
          keep: { start: 1.0, end: 38.0 },
          cuts: [],
          summary: "Mid-clip action beat.",
          confidence: "medium",
        });
      }
      return textResponse({
        start: 17.8,
        peak: 18.3,
        end: 19.1,
        focus: {
          start: { x: 0.35, y: 0.4 },
          peak: { x: 0.62, y: 0.58 },
          end: { x: 0.44, y: 0.52 },
        },
      });
    };

    const queued = parseResult<{ status: string; job_id: number }>(
      await autoEditDef(engine).handler({ book_id: bookId, asset_id: artifactId, op: "analyze" }),
    );
    const job = await waitForJob(queued.job_id);
    expect(job.state).toBe("done");
    expect(captured).toHaveLength(2);

    const pass1Frames = frameLabels(captured[0]!);
    const pass2Frames = frameLabels(captured[1]!);
    expect(pass1Frames).toHaveLength(48);
    expect(pass2Frames.length).toBeGreaterThanOrEqual(2);
    expect(pass2Frames.length).toBeLessThanOrEqual(24);
    for (const frame of pass2Frames) {
      expect(frame.time).toBeGreaterThanOrEqual(17.0 - 0.02);
      expect(frame.time).toBeLessThanOrEqual(20.0 + 0.02);
    }

    const got = await readAutoEditGet(engine, artifactId);
    expect(got.draft.anchors.moment.start).toBeCloseTo(17.8, 1);
    expect(got.draft.anchors.moment.peak).toBeCloseTo(18.3, 1);
    expect(got.draft.anchors.moment.end).toBeCloseTo(19.1, 1);
    expect(got.draft.anchors.focus.peak).toEqual({ x: 0.62, y: 0.58 });
    expect(got.analysis).toMatchObject({ status: "ready", confidence: "medium", summary: "Mid-clip action beat." });
  }, testBudget(120_000));

  it("repairs invalid anchors via normalizeAnchors, invalidates on byte/transcript changes, and reports failed cleanly", async () => {
    const { artifactId, sourceHash } = await addVideoArtifact(join(fixtureRoot, "clip9s.mp4"));
    const customSections = { ...DEFAULT_AUTO_EDIT_SECTIONS, coldOpen: false, crash: false };
    const saved = saveAutoEditDraft(engine, artifactId, sourceHash, (await readAutoEditGet(engine, artifactId)).draft.anchors, customSections);

    responder = () => textResponse({
      moment: { start: 5.5, peak: 5.0, end: 6.2 },
      focus: {
        start: { x: 0.5, y: 0.5 },
        peak: { x: 0.5, y: 0.5 },
        end: { x: 0.5, y: 0.5 },
      },
      hook: { start: 3.5, end: 6.0 },
      keep: { start: 0, end: 9 },
      cuts: [{ start: 4.8, end: 6.3, reason: "overlaps moment" }],
      summary: "Repaired anchors.",
      confidence: "low",
    });

    const q1 = parseResult<{ job_id: number }>(
      await autoEditDef(engine).handler({ book_id: bookId, asset_id: artifactId, op: "analyze" }),
    );
    const job1 = await waitForJob(q1.job_id);
    expect(job1.state).toBe("done");

    const afterRepair = await readAutoEditGet(engine, artifactId);
    expect(afterRepair.draft.sections).toEqual(customSections);
    expect(afterRepair.changes.length).toBeGreaterThanOrEqual(3);
    expect(afterRepair.draft.anchors.cuts).toEqual([]);
    expect(afterRepair.draft.anchors.moment.start).toBeLessThan(afterRepair.draft.anchors.moment.peak);
    expect(afterRepair.draft.revision).not.toBe(saved.revision);

    // Changing transcript invalidates the cached key.
    await engine.files.write(artifactId, TIMED_TRANSCRIPT_FILE, Buffer.from(JSON.stringify({
      text: "now with transcript",
      words: [{ text: "now", start: 0.1, end: 0.4, type: "word" }],
    })));
    expect((await readAutoEditGet(engine, artifactId)).analysis.status).toBe("none");

    // Refusal fails the job without changing the draft or marking the video errored.
    responder = () => refusalResponse("cannot process this video");
    const q2 = parseResult<{ job_id: number }>(
      await autoEditDef(engine).handler({ book_id: bookId, asset_id: artifactId, op: "analyze" }),
    );
    const job2 = await waitForJob(q2.job_id);
    expect(job2.state).toBe("failed");

    const afterFail = await readAutoEditGet(engine, artifactId);
    expect(afterFail.analysis.status).toBe("failed");
    expect(afterFail.analysis.error).toContain("cannot process this video");
    expect(afterFail.draft.anchors).toEqual(afterRepair.draft.anchors);
    const status = await engine.status.get(artifactId);
    expect(status.ok && status.value).toBe("ready");

    // Malformed answer fails the job cleanly too.
    responder = () => textResponse({ bad: true });
    const q3 = parseResult<{ job_id: number }>(
      await autoEditDef(engine).handler({ book_id: bookId, asset_id: artifactId, op: "analyze" }),
    );
    const job3 = await waitForJob(q3.job_id);
    expect(job3.state).toBe("failed");
    expect((await readAutoEditGet(engine, artifactId)).analysis.status).toBe("failed");

    // Changing video bytes drops old state back to none.
    const altPath = join(fixtureRoot, "clip9s-alt.mp4");
    await engine.files.writeFromPath(artifactId, "original.mp4", altPath);
    const newManifest = await engine.files.manifest(artifactId);
    if (!newManifest.ok) throw new Error(newManifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(newManifest.value.path, "original.mp4")));
    expect((await readAutoEditGet(engine, artifactId)).analysis.status).toBe("none");
  }, testBudget(120_000));
});

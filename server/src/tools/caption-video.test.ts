import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_ALIVE_SETTINGS_KEY } from "../captions/legacy.js";
import type { CaptionDocument } from "../captions/model.js";
import type { CaptionReadModel } from "../captions/service.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { queue, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { getAllToolDefs } from "./index.js";
import { buildRoutableTools } from "../chat-router.js";

const execFileAsync = promisify(execFile);
const BURSTS = "sin(2*PI*440*t)*(0.8*between(t,0.5,0.8)+0.8*between(t,1.0,1.7)+0.2*between(t,2.5,2.8))";

function transcript(third = "burning.") {
  return {
    language_code: "eng",
    words: [
      { text: "We", start: 0.5, end: 0.7, type: "word" },
      { text: " ", start: 0.7, end: 0.7, type: "spacing" },
      { text: "were", start: 0.7, end: 0.95, type: "word" },
      { text: third, start: 1.05, end: 1.7, type: "word" },
      { text: "quiet", start: 2.5, end: 2.8, type: "word" },
    ],
  };
}

type TextContent = Array<{ type: string; text: string }>;
type Read = CaptionReadModel & { document: CaptionDocument; draft: NonNullable<CaptionReadModel["draft"]> };
type Saved = { status: string; revision: string; saved: boolean; reseed: { kept: number; unplaced: number } | null; document?: CaptionDocument };
type Payload = Partial<Read> & Partial<Saved> & { message?: string; status?: string; revision?: string | null };

describe("caption_video", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let mediaCount = 0;
  const bookId = "caption-video-book";

  async function render(audio: boolean): Promise<Buffer> {
    mediaCount += 1;
    const output = join(tempDir, `clip-${mediaCount}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `color=c=gray:s=320x180:r=24:d=3.2,drawbox=x=${mediaCount * 9}:y=8:w=24:h=24:c=white:t=fill`,
      ...(audio ? ["-f", "lavfi", "-i", `aevalsrc='${BURSTS}':s=44100:d=3.2`] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-shortest"] : ["-an"]),
      output,
    ]);
    return readFile(output);
  }

  async function writeVideo(artifactId: string, bytes: Buffer): Promise<void> {
    const written = await engine.files.write(artifactId, "original.mp4", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
  }

  async function writeTranscript(artifactId: string, value: object): Promise<void> {
    const written = await engine.files.write(artifactId, "elevenlabs.json", JSON.stringify(value));
    if (!written.ok) throw new Error(written.error.message);
  }

  async function video(options: { audio?: boolean; transcript?: object | null } = {}): Promise<string> {
    const created = await engine.artifacts.create("video", "night drive");
    if (!created.ok) throw new Error(created.error.message);
    await writeVideo(created.value.artifactId, await render(options.audio ?? true));
    if (options.transcript !== null) await writeTranscript(created.value.artifactId, options.transcript ?? transcript());
    return created.value.artifactId;
  }

  async function call(args: Record<string, unknown>): Promise<{ error: boolean; body: Payload }> {
    const result = await client.callTool({ name: "caption_video", arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    try {
      return { error: result.isError === true, body: JSON.parse(text) as Payload };
    } catch {
      return { error: result.isError === true, body: { message: text } };
    }
  }

  async function ok<T = Read>(args: Record<string, unknown>): Promise<T> {
    const result = await call(args);
    if (result.error) throw new Error(JSON.stringify(result.body));
    return result.body as T;
  }

  async function save(args: Record<string, unknown>): Promise<Saved> {
    return ok<Saved>({ op: "update", ...args });
  }

  async function ready(assetId: string, language = "original"): Promise<Read> {
    await ok({ asset_id: assetId, op: "prepare", language });
    await expect.poll(async () => (await ok({ asset_id: assetId, language })).status, { timeout: testBudget(30_000) }).toBe("ready");
    return ok({ asset_id: assetId, language, detail: "full" });
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-caption-video-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reads status without starting work, prepares free vocal timing, then serves a seeded draft", async () => {
    const assetId = await video();
    const first = await ok({ asset_id: assetId });
    expect(first).toMatchObject({ status: "needs_prepare", draft: null, components: { transcript: { status: "ready" }, vocal: { status: "missing" }, regions: { status: "unavailable" } } });
    expect(engine.jobs.queue.list({ type: "caption_vocal", limit: 50 }).filter((job) => job.payload.sourceArtifactId === assetId)).toHaveLength(0);
    const full = await ready(assetId);
    expect(full.draft).toMatchObject({ saved: false, stale_source: false, analysis_newer: false, word_count: 4, word_timing: "measured" });
    expect(full.draft.revision).toMatch(/^seed:/);
    expect(full.document.words.map((word) => word.text)).toEqual(["We", "were", "burning", "quiet"]);
    expect(full.document.style.preset).toBe("karaoke");
    expect(full.document.aspect).toBe("9:16");
    expect(full.source).toMatchObject({ width: 320, height: 180, fps: 24, has_audio: true });
    expect(full.envelope?.values.length).toBeGreaterThan(0);
    const summary = await ok({ asset_id: assetId });
    expect(summary.document).toBeUndefined();
    expect(summary.envelope).toBeUndefined();
  });

  it("saves edits against the reviewed revision and refuses stale revisions", async () => {
    const assetId = await video();
    const full = await ready(assetId);
    const saved = await save({
      asset_id: assetId, expected_revision: full.draft.revision,
      edits: [{ op: "set_word_text", word_id: "w2", text: "are" }, { op: "set_position", y: 0.35 }],
    });
    expect(saved).toMatchObject({ status: "saved", saved: true });
    const after = await ok({ asset_id: assetId, detail: "full" });
    expect(after.draft).toMatchObject({ revision: saved.revision, saved: true, corrected_words: 1 });
    expect(after.document.positions).toEqual({ "9:16": 0.35 });
    const conflict = await call({ asset_id: assetId, op: "update", expected_revision: full.draft.revision, edits: [{ op: "hide_word", word_id: "w1", hidden: true }] });
    expect(conflict).toMatchObject({ error: true, body: { status: "conflict", revision: saved.revision } });
    const invalid = await call({ asset_id: assetId, op: "update", expected_revision: saved.revision, edits: [{ op: "set_word_timing", word_id: "w3", start: 0.1, end: 0.3 }] });
    expect(invalid).toMatchObject({ error: true, body: { status: "invalid" } });
    const replacement = { ...after.document, style: { ...after.document.style, preset: "stack" } };
    const replaced = await save({ asset_id: assetId, expected_revision: saved.revision, document: replacement });
    expect((await ok({ asset_id: assetId, detail: "full" })).document.style.preset).toBe("stack");
    const rebound = await call({ asset_id: assetId, op: "update", expected_revision: replaced.revision, document: { ...replacement, source: { ...replacement.source, durationSeconds: 99 } } });
    expect(rebound).toMatchObject({ error: true, body: { status: "invalid" } });
    const both = await call({ asset_id: assetId, op: "update", expected_revision: replaced.revision, edits: [], resolve: "discard" });
    expect(both).toMatchObject({ error: true, body: { status: "invalid" } });
  });

  it("flags newer analysis and reseeds while keeping corrections", async () => {
    const assetId = await video();
    const full = await ready(assetId);
    const saved = await save({ asset_id: assetId, expected_revision: full.draft.revision, edits: [{ op: "set_word_text", word_id: "w3", text: "turning" }] });
    await writeTranscript(assetId, transcript("yearning."));
    const newer = await ready(assetId);
    expect(newer.draft).toMatchObject({ revision: saved.revision, analysis_newer: true, stale_source: false });
    const reseeded = await save({ asset_id: assetId, expected_revision: saved.revision, resolve: "reseed", detail: "full" });
    expect(reseeded.reseed).toMatchObject({ kept: 1, unplaced: 0 });
    expect(reseeded.document?.words.map((word) => word.text)).toEqual(["We", "were", "turning", "quiet"]);
    expect((await ok({ asset_id: assetId })).draft.analysis_newer).toBe(false);
  });

  it("refuses edits on a changed video until the user keeps the timings, realigns or discards", async () => {
    const assetId = await video();
    const full = await ready(assetId);
    const saved = await save({ asset_id: assetId, expected_revision: full.draft.revision, edits: [{ op: "set_word_text", word_id: "w1", text: "Us" }] });
    await writeVideo(assetId, await render(true));
    const stale = await ok({ asset_id: assetId });
    expect(stale.draft).toMatchObject({ stale_source: true, revision: saved.revision });
    const refused = await call({ asset_id: assetId, op: "update", expected_revision: saved.revision, edits: [{ op: "hide_word", word_id: "w2", hidden: true }] });
    expect(refused).toMatchObject({ error: true, body: { status: "stale_source" } });
    await ready(assetId);
    const kept = await save({ asset_id: assetId, expected_revision: saved.revision, resolve: "keep_timings", detail: "full" });
    expect(kept.document?.words[0]).toMatchObject({ text: "Us", textCorrected: true });
    const now = await ok({ asset_id: assetId });
    expect(now.draft).toMatchObject({ stale_source: false, corrected_words: 1 });
    const discarded = await save({ asset_id: assetId, expected_revision: now.draft.revision, resolve: "discard" });
    expect(discarded).toMatchObject({ saved: false });
    expect((await ok({ asset_id: assetId })).draft).toMatchObject({ saved: false, corrected_words: 0 });
  });

  it("reports silent videos, unavailable providers and translation needs without spending", async () => {
    const silent = await video({ audio: false, transcript: null });
    expect(await ok({ asset_id: silent, op: "prepare" })).toMatchObject({ status: "silent", draft: null });
    const untranscribed = await video({ transcript: null });
    expect(await ok({ asset_id: untranscribed })).toMatchObject({ status: "unavailable", message: expect.stringMatching(/ELEVENLABS_API_KEY/), paid_work: [] });
    const translated = await video();
    await ready(translated);
    expect(await ok({ asset_id: translated, language: "es", op: "prepare" })).toMatchObject({
      status: "unavailable",
      message: expect.stringMatching(/OPENAI_API_KEY/),
      components: { translation: { status: "unavailable" } },
    });
    const invalid = await call({ asset_id: translated, language: "spanish" });
    expect(invalid).toMatchObject({ error: true, body: { message: expect.stringMatching(/language/) } });
  });

  it("seeds the draft style from saved Alive settings", async () => {
    const assetId = await video();
    const written = await engine.metadata.artifacts.write(assetId, LEGACY_ALIVE_SETTINGS_KEY, { style: "punch", motion: "slam", hitColor: "#72e7aa" });
    if (!written.ok) throw new Error(written.error.message);
    const full = await ready(assetId);
    expect(full.document.style).toMatchObject({ preset: "punch", motion: "slam", highlightColor: "#72E7AA" });
  });

  it("is billable only when preparing and stays out of chat routing", () => {
    expect(toolSpendsMoney("caption_video", { op: "prepare" })).toBe(true);
    expect(toolSpendsMoney("caption_video", { op: "get" })).toBe(false);
    expect(toolSpendsMoney("caption_video", {})).toBe(false);
    expect(toolSpendsMoney("caption_video")).toBe(true);
    const routable = buildRoutableTools(getAllToolDefs(engine)).map((tool) => tool.name);
    expect(routable).not.toContain("caption_video");
    expect(routable).toContain("trim_video");
  });
});

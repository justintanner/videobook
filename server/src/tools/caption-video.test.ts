import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { NOTEBOOK_GRID_COLUMN_COUNT, NOTEBOOK_GRID_ROW_COUNT } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAnalysisComponent } from "../analysis-components.js";
import { CAPTION_TRANSLATION, translationComponentKey } from "../captions/analysis.js";
import { captionsToSubtitleFile } from "../captions/export.js";
import { LEGACY_ALIVE_SETTINGS_KEY } from "../captions/legacy.js";
import type { CaptionDocument } from "../captions/model.js";
import { groupPhrases } from "../captions/phrasing.js";
import { joinCaptionWords } from "../captions/script.js";
import type { CaptionReadModel } from "../captions/service.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { synthesizeWordTimings } from "../jobs/_translate-transcript.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { pauseBookQueueForTests, queue, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
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

function letters(texts: readonly string[], start: number, step: number) {
  return texts.map((text, index) => ({ text, start: start + index * step, end: start + (index + 1) * step, type: "word" }));
}

const THAI_CLAUSES = ["ฉันชอบกินข้าวมาก", "แมวนอนอยู่บนโต๊ะ"];

function thaiTranscript() {
  return {
    language_code: "tha",
    words: [
      ...letters(["ฉั", "น", "ช", "อ", "บ", "กิ", "น", "ข้", "า", "ว", "ม", "า", "ก"], 0.5, 0.1),
      { text: " ", start: 1.8, end: 1.8, type: "spacing" },
      ...letters(["แ", "ม", "ว", "น", "อ", "น", "อ", "ยู่", "บ", "น", "โ", "ต๊", "ะ"], 2, 0.08),
    ],
  };
}

function phraseTexts(document: CaptionDocument): string[] {
  return document.phrases.map((phrase) => joinCaptionWords(phrase.wordIds.map((id) => document.words.find((word) => word.id === id)!.text)));
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

  async function fileHashes(artifactId: string): Promise<Record<string, string>> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return Object.fromEntries(manifest.value.files.map((file) => [file.name, file.objectHash]));
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

  it("captions Thai from ElevenLabs letters as whole words and keeps its clause space", async () => {
    const assetId = await video({ transcript: thaiTranscript() });
    const full = await ready(assetId);
    expect(full.document.words.map((word) => word.text)).toEqual(["ฉัน", "ชอบ", "กิน", "ข้าว", "มาก", "แมว", "นอน", "อยู่", "บน", "โต๊ะ"]);
    expect(full.document.words[1]).toMatchObject({ start: 0.7, end: 1 });
    expect(phraseTexts(full.document)).toEqual(THAI_CLAUSES);
    expect(full.draft).toMatchObject({ word_count: 10, phrase_count: 2 });
    expect(captionsToSubtitleFile(full.document, "srt")).toContain(`${THAI_CLAUSES[0]}\n`);
  });

  it("seeds Thai subtitles from a translation with one phrase per Thai clause", async () => {
    const assetId = await video();
    const text = THAI_CLAUSES.join(" ");
    const sidecar = { targetLanguage: "th", segments: [{ start: 0.5, end: 2.8, text, words: synthesizeWordTimings(text, 0.5, 2.8) }] };
    const written = await engine.files.write(assetId, "elevenlabs.th.json", JSON.stringify(sidecar));
    if (!written.ok) throw new Error(written.error.message);
    const hashes = await fileHashes(assetId);
    writeAnalysisComponent(engine, {
      component: CAPTION_TRANSLATION.component,
      key: translationComponentKey(hashes["original.mp4"], hashes["elevenlabs.json"], "th"),
      artifactId: assetId,
      sourceHash: hashes["original.mp4"],
      provenance: { analyzer: "test", version: CAPTION_TRANSLATION.version, provider: null, model: null, createdAt: new Date().toISOString() },
      value: { file: "elevenlabs.th.json", fileHash: hashes["elevenlabs.th.json"], language: "th", wordCount: 10 },
    });
    const full = await ready(assetId, "th");
    expect(full.document).toMatchObject({ language: "th", wordTiming: "estimated" });
    expect(phraseTexts(full.document)).toEqual(THAI_CLAUSES);
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

  it("loads a saved character-level Thai draft as complete words and fences the old review", async () => {
    const text = "นี่คือสวนสนุกร้าง";
    const tokens = [...text].map((part, index) => ({ text: part, start: (index + 1) / 10, end: (index + 2) / 10, type: "word" }));
    const assetId = await video({ transcript: { language_code: "tha", text, words: tokens } });
    const full = await ready(assetId);
    expect(full.document.words.map((word) => word.text)).toEqual(["นี่", "คือ", "สวน", "สนุก", "ร้าง"]);
    const words = tokens.map((token, index) => ({
      ...full.document.words[0], id: `w${index + 1}`, text: token.text, start: token.start, end: token.end,
      analysed: { text: token.text, start: token.start, end: token.end, onset: token.start, energy: 0.5 },
    }));
    const phrases = groupPhrases(words).map((wordIds, index) => ({ id: `p${words.length + index + 1}`, wordIds, positions: {} }));
    const legacy = {
      revision: randomUUID(), updatedAt: new Date().toISOString(),
      document: {
        ...full.document, words, phrases, nextId: words.length + phrases.length + 1, wordSegmentationVersion: undefined,
        style: { ...full.document.style, fontScale: 1.35, snapToOnsets: false }, positions: { "9:16": 0.68 },
      },
    };
    const key = `captions.draft.${assetId}.original`;
    expect(engine.settings.set(key, legacy).ok).toBe(true);
    const recovered = await ok({ asset_id: assetId, detail: "full" });
    expect(recovered.draft).toMatchObject({ saved: true, word_count: 5, phrase_count: 1 });
    expect(recovered.document.words.map((word) => word.text)).toEqual(["นี่", "คือ", "สวน", "สนุก", "ร้าง"]);
    expect(recovered.document.style.fontScale).toBe(1.35);
    expect(recovered.document.positions).toEqual({ "9:16": 0.68 });
    expect(recovered.draft.revision).not.toBe(legacy.revision);
    expect((await ok({ asset_id: assetId })).draft.revision).toBe(recovered.draft.revision);
    expect(engine.settings.get(key)).toEqual(legacy);
    expect(await call({ asset_id: assetId, op: "update", expected_revision: legacy.revision, edits: [{ op: "set_word_text", word_id: "w7", text: "สวน!" }] }))
      .toMatchObject({ error: true, body: { status: "conflict", revision: recovered.draft.revision } });
    const saved = await save({ asset_id: assetId, expected_revision: recovered.draft.revision, edits: [{ op: "set_word_text", word_id: "w7", text: "สวน!" }], detail: "full" });
    const reloaded = await ok({ asset_id: assetId, detail: "full" });
    expect(reloaded.draft.revision).toBe(saved.revision);
    expect(reloaded.document.words.find((word) => word.id === "w7")).toMatchObject({ text: "สวน!", textCorrected: true, start: 0.7, end: 1 });
    expect(captionsToSubtitleFile(reloaded.document, "srt")).toContain("นี่คือสวน! สนุกร้าง\n");
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

  async function notebookWith(assetId: string, fill = false): Promise<string> {
    const notebook = await engine.notebooks.create(`Captions ${randomUUID()}`);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cells = [engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId })];
    for (let row = 0; fill && row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
      for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
        if (row === 0 && column === 0) continue;
        cells.push(engine.notebooks.createCell({ type: "prompt", slot: { row, column }, prompt: "filler" }));
      }
    }
    const written = await engine.notebooks.write({ ...notebook.value, cells });
    if (!written.ok) throw new Error(written.error.message);
    return notebook.value.id;
  }

  it("validates render requests before queueing and reuses a request on retry", async () => {
    const assetId = await video();
    const full = await ready(assetId);
    const notebookId = await notebookWith(assetId);
    const realBookId = engine.book.get().bookId;
    const requestId = randomUUID();
    const base = { asset_id: assetId, op: "render", notebook_id: notebookId, source_hash: full.source.media_hash };
    await pauseBookQueueForTests(realBookId);
    try {
      const first = await ok<{ render: { status: string; job_id: number; output_asset_id: string } }>({ ...base, expected_revision: full.draft.revision, request_id: requestId });
      expect(first.render).toMatchObject({ status: "queued" });
      const persisted = await ok({ asset_id: assetId });
      expect(persisted.draft).toMatchObject({ saved: true });
      expect(persisted).toMatchObject({ render: { status: "queued", job_id: first.render.job_id } });
      const retried = await ok<{ render: { job_id: number; output_asset_id: string } }>({ ...base, expected_revision: full.draft.revision, request_id: requestId });
      expect(retried.render).toMatchObject({ job_id: first.render.job_id, output_asset_id: first.render.output_asset_id });
      const reused = await call({ ...base, expected_revision: persisted.draft.revision, request_id: requestId });
      expect(reused).toMatchObject({ error: true, body: { status: "invalid", message: expect.stringMatching(/different render/) } });
      const hidden = await save({
        asset_id: assetId, expected_revision: persisted.draft.revision,
        edits: ["w1", "w2", "w3", "w4"].map((id) => ({ op: "hide_word", word_id: id, hidden: true })),
      });
      const empty = await call({ ...base, expected_revision: hidden.revision, request_id: randomUUID() });
      expect(empty).toMatchObject({ error: true, body: { status: "invalid", message: expect.stringMatching(/no words/) } });
      for (const job of engine.jobs.queue.list({ type: "render_captions", limit: 50 }).filter((candidate) => candidate.state === "queued")) {
        await engine.jobs.queue.abort(job.id, "render validation test");
      }
    } finally {
      await resumeBookQueueForTests(realBookId);
    }
    const full2 = await ready(await video());
    const crowded = await notebookWith(full2.asset_id, true);
    const noRoom = await call({ asset_id: full2.asset_id, op: "render", notebook_id: crowded, source_hash: full2.source.media_hash, expected_revision: full2.draft.revision, request_id: randomUUID() });
    expect(noRoom).toMatchObject({ error: true, body: { status: "invalid", message: expect.stringMatching(/empty cell/) } });
  });

  it("forgetting a video clears its drafts, cached analysis and render records", async () => {
    const assetId = await video();
    const full = await ready(assetId);
    await save({ asset_id: assetId, expected_revision: full.draft.revision, edits: [{ op: "set_word_text", word_id: "w1", text: "Us" }] });
    const keys = () => [`captions.draft.${assetId}.original`, `captions.drafts.${assetId}`, `analysis.index.${assetId}`].filter((key) => engine.settings.get(key) !== null);
    expect(keys()).toHaveLength(3);
    const forgotten = await client.callTool({ name: "delete_asset", arguments: { book_id: bookId, asset_id: assetId, forget: true } });
    expect(forgotten.isError).not.toBe(true);
    expect(keys()).toEqual([]);
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

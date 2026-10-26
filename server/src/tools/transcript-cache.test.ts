import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, Job } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileObjectHash, recordSidecarAnalysis } from "../analysis-sidecars.js";
import { createEngineForTest } from "../engine.js";
import { computeSourceTextHash } from "../jobs/_translate-transcript.js";
import { pauseBookQueueForTests, queue, resumeBookQueueForTests, waitForBookJob, waitForBookQueuesIdleForTests } from "../queue.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  elevenLabsTranscriptKey,
  recordElevenLabsTranscript,
  recordOpenAiTranscript,
} from "../transcript-components.js";
import { transcriptTranslationRecord, transcriptTranslationSpec } from "../transcript-translation.js";

type TextContent = Array<{ type: string; text: string }>;

interface ToolStatus {
  status: string;
  job_id: number | null;
  provider?: string;
  reason?: string;
}

const TRANSCRIPT = {
  language_code: "eng",
  words: [
    { text: "Night", start: 0.2, end: 0.5, type: "word" },
    { text: " ", start: 0.5, end: 0.5, type: "spacing" },
    { text: "drive.", start: 0.5, end: 0.9, type: "word" },
  ],
};

describe("transcript and translation components", () => {
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let tempDir: string;

  async function call(name: string, args: Record<string, unknown>): Promise<ToolStatus> {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as ToolStatus;
  }

  async function write(artifactId: string, name: string, content: string | Buffer): Promise<void> {
    const written = await engine.files.write(artifactId, name, content);
    if (!written.ok) throw new Error(written.error.message);
  }

  async function clip(kind: "video" | "audio", audio: string): Promise<string> {
    const created = await engine.artifacts.create(kind, `${kind} clip`);
    if (!created.ok) throw new Error(created.error.message);
    await write(created.value.artifactId, "original.mp3", Buffer.from(audio));
    return created.value.artifactId;
  }

  async function transcribed(artifactId: string): Promise<string> {
    await write(artifactId, "elevenlabs.json", JSON.stringify(TRANSCRIPT));
    const audioHash = await fileObjectHash(engine, artifactId, "original.mp3");
    if (!audioHash) throw new Error("audio missing");
    await recordElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS });
    return audioHash;
  }

  function jobs(type: string, artifactId: string): Job[] {
    return engine.jobs.queue.list({ type, limit: 500 }).filter((job) => job.payload.assetId === artifactId);
  }

  async function settled(jobId: number): Promise<Job> {
    await waitForBookJob(bookId, jobId, testBudget(20_000)).catch(() => undefined);
    const job = engine.jobs.queue.get(jobId);
    if (!job) throw new Error(`job ${jobId} missing`);
    return job;
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-transcript-cache-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
  });

  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await resumeBookQueueForTests(bookId).catch(() => undefined);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("serves the transcript the current audio already has without a job or a write", async () => {
    const artifactId = await clip("audio", "podcast audio");
    await transcribed(artifactId);
    const before = JSON.stringify(await engine.files.manifest(artifactId, { includeDotfiles: true }));

    expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "cached", job_id: null, provider: "elevenlabs" });
    expect(await call("transcribe", { asset_id: artifactId, wait: true })).toMatchObject({ status: "cached", job_id: null });
    expect(jobs("transcribe", artifactId)).toEqual([]);
    expect(JSON.stringify(await engine.files.manifest(artifactId, { includeDotfiles: true }))).toBe(before);
  });

  it("adopts a transcript from before component records only for the default settings", async () => {
    const artifactId = await clip("video", "interview audio");
    await write(artifactId, "elevenlabs.json", JSON.stringify(TRANSCRIPT));
    await pauseBookQueueForTests(bookId);
    try {
      expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "cached" });
      const french = await call("transcribe", { asset_id: artifactId, language_code: "fr" });
      expect(french).toMatchObject({ status: "queued" });
      expect(french.job_id).toEqual(expect.any(Number));
    } finally {
      await resumeBookQueueForTests(bookId);
    }
  });

  it("shares one job between concurrent and forced requests and keeps the old transcript when the refresh fails", async () => {
    const artifactId = await clip("audio", "song audio");
    const audioHash = await transcribed(artifactId);
    const transcriptHash = await fileObjectHash(engine, artifactId, "elevenlabs.json");
    await pauseBookQueueForTests(bookId);
    let jobId: number | null = null;
    try {
      const [first, second] = await Promise.all([
        call("transcribe", { asset_id: artifactId, force: true }),
        call("transcribe", { asset_id: artifactId, force: true }),
      ]);
      jobId = first.job_id;
      expect(second.job_id).toBe(jobId);
      expect(await call("transcribe", { asset_id: artifactId, force: true })).toMatchObject({ status: "queued", job_id: jobId });
      const queued = jobs("transcribe", artifactId);
      expect(queued).toHaveLength(1);
      expect(queued[0].payload.componentKey).toBe(elevenLabsTranscriptKey(audioHash, DEFAULT_TRANSCRIPT_OPTIONS));
    } finally {
      await resumeBookQueueForTests(bookId);
    }
    expect((await settled(jobId as number)).state).toBe("failed");
    expect(await fileObjectHash(engine, artifactId, "elevenlabs.json")).toBe(transcriptHash);
    expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "cached" });
  });

  it("invalidates the transcript when the audio changes", async () => {
    const artifactId = await clip("audio", "first take");
    await transcribed(artifactId);
    await write(artifactId, "original.mp3", Buffer.from("second take"));
    await pauseBookQueueForTests(bookId);
    try {
      expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "queued" });
    } finally {
      await resumeBookQueueForTests(bookId);
    }
  });

  it("finishes an automatic transcribe job for already transcribed audio without calling the provider", async () => {
    const artifactId = await clip("video", "upload audio");
    const audioHash = await transcribed(artifactId);
    const job = await queue.enqueue(`transcribe-elevenlabs-${artifactId}-rev`, {
      type: "transcribe",
      audioPath: "original.mp3",
      audioFilename: "original.mp3",
      tagAudioEvents: true,
      diarize: true,
      assetId: artifactId,
      assetDir: "",
      bookId,
      componentKey: elevenLabsTranscriptKey(audioHash, DEFAULT_TRANSCRIPT_OPTIONS),
    });
    const done = await settled(job.id);
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({ success: true, cached: true });
  });

  it("caches OpenAI speech-to-text per media file", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const created = await engine.artifacts.create("video", "silent sidecar");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    await write(artifactId, "original.mp4", Buffer.from("fake mp4"));
    await pauseBookQueueForTests(bookId);
    try {
      expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "queued", provider: "openai" });
    } finally {
      await resumeBookQueueForTests(bookId);
    }
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) });
    await write(artifactId, ".analysis.gpt4otrans.json", JSON.stringify({ text: "night drive" }));
    const mediaHash = await fileObjectHash(engine, artifactId, "original.mp4");
    await recordOpenAiTranscript(engine, artifactId, mediaHash as string);
    expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "cached", provider: "openai" });
  });

  it("caches translations per transcript and language, without a key when nothing has to run", async () => {
    const artifactId = await clip("video", "translated");
    await transcribed(artifactId);
    const transcriptHash = await fileObjectHash(engine, artifactId, "elevenlabs.json") as string;
    await write(artifactId, "elevenlabs.fr.json", JSON.stringify({ language_code: "fr", words: [] }));
    await recordSidecarAnalysis(engine, transcriptTranslationSpec("fr"), {
      ...transcriptTranslationRecord(engine, artifactId, transcriptHash, "fr"),
      provenance: { analyzer: "test", provider: null, model: null },
    });

    expect(await call("translate_subtitles", { asset_id: artifactId, language: "fr" })).toMatchObject({ status: "cached", job_id: null });
    expect(await call("translate_subtitles", { asset_id: artifactId, language: "en" })).toMatchObject({ status: "not_needed" });
    await expect(call("translate_subtitles", { asset_id: artifactId, language: "de" })).rejects.toThrow("OPENAI_API_KEY");

    vi.stubEnv("OPENAI_API_KEY", "test-key");
    await write(artifactId, "elevenlabs.json", JSON.stringify({ ...TRANSCRIPT, words: TRANSCRIPT.words.slice(0, 1) }));
    await pauseBookQueueForTests(bookId);
    try {
      const [first, second] = await Promise.all([
        call("translate_subtitles", { asset_id: artifactId, language: "fr" }),
        call("translate_subtitles", { asset_id: artifactId, language: "fr" }),
      ]);
      expect(first).toMatchObject({ status: "queued" });
      expect(second.job_id).toBe(first.job_id);
    } finally {
      await resumeBookQueueForTests(bookId);
    }
  });

  it("adopts a translation from before component records when it matches the transcript text", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const artifactId = await clip("video", "legacy translation");
    await write(artifactId, "elevenlabs.json", JSON.stringify(TRANSCRIPT));
    await write(artifactId, "elevenlabs.es.json", JSON.stringify({
      sourceTextHash: computeSourceTextHash(parseSegments(TRANSCRIPT as Parameters<typeof parseSegments>[0])),
      language_code: "es",
      words: [],
    }));
    await write(artifactId, "elevenlabs.it.json", JSON.stringify({ sourceTextHash: "stale", language_code: "it", words: [] }));

    expect(await call("translate_subtitles", { asset_id: artifactId, language: "es" })).toMatchObject({ status: "cached" });
    const job = await queue.enqueue(`translate-${artifactId}-es`, { type: "translate_transcript", assetId: artifactId, bookId, targetLanguage: "es" });
    expect((await settled(job.id)).result).toMatchObject({ success: true, cached: true });

    await pauseBookQueueForTests(bookId);
    try {
      expect(await call("translate_subtitles", { asset_id: artifactId, language: "it" })).toMatchObject({ status: "queued" });
    } finally {
      await resumeBookQueueForTests(bookId);
    }
  });
});

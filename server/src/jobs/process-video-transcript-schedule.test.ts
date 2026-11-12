import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import {
  planVideoTranscriptJobs,
  processVideoFiles,
  type PlanVideoTranscriptJobsInput,
} from "./process-video.js";
import { declinesTranscription, DEFAULT_TRANSCRIPT_OPTIONS, elevenLabsTranscriptKey, openAiTranscriptKey } from "../transcript-components.js";

const here = dirname(fileURLToPath(import.meta.url));

const BASE: PlanVideoTranscriptJobsInput = {
  skipDownstreamJobs: false,
  hasAudio: true,
  assetId: "artifact-video-1",
  assetDir: "/books/demo/artifacts/artifact-video-1",
  bookId: "book-1",
  videoFilename: "original.mp4",
  identity: "rev-abc",
  audioHash: null,
  hasOpenAiKey: false,
  hasElevenLabsKey: false,
};

function plan(overrides: Partial<PlanVideoTranscriptJobsInput> = {}) {
  return planVideoTranscriptJobs({ ...BASE, ...overrides });
}

describe("planVideoTranscriptJobs", () => {
  it("schedules nothing when no provider keys are set", () => {
    expect(plan()).toEqual([]);
  });

  it("schedules only OpenAI when that key is present", () => {
    const jobs = plan({ hasOpenAiKey: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "transcribe-openai-artifact-video-1-rev-abc",
      payload: {
        type: "transcribe_video_audio",
        videoPath: join(BASE.assetDir, "original.mp4"),
        assetId: BASE.assetId,
        assetDir: BASE.assetDir,
        bookId: BASE.bookId,
        sourceFilename: "original.mp3",
        mediaRevision: "rev-abc",
      },
    });
  });

  it("schedules only ElevenLabs when that key is present", () => {
    const jobs = plan({ hasElevenLabsKey: true });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "transcribe-elevenlabs-artifact-video-1-rev-abc",
      payload: {
        type: "transcribe",
        audioPath: join(BASE.assetDir, "original.mp3"),
        audioFilename: "original.mp3",
        tagAudioEvents: true,
        diarize: true,
        assetId: BASE.assetId,
        assetDir: BASE.assetDir,
        bookId: BASE.bookId,
      },
    });
  });

  it("schedules both providers independently with distinct identities", () => {
    const jobs = plan({ hasOpenAiKey: true, hasElevenLabsKey: true });
    expect(jobs.map((job) => job.payload.type)).toEqual([
      "transcribe_video_audio",
      "transcribe",
    ]);
    expect(jobs[0].jobId).not.toBe(jobs[1].jobId);
    expect(jobs[0].jobId).toContain("openai");
    expect(jobs[1].jobId).toContain("elevenlabs");
  });

  it("points the OpenAI payload at a durable artifact-owned file", () => {
    const jobs = plan({ hasOpenAiKey: true });
    const payload = jobs[0]?.payload;
    expect(payload?.type).toBe("transcribe_video_audio");
    if (payload?.type !== "transcribe_video_audio") return;
    expect(payload.videoPath).toBe(join(BASE.assetDir, BASE.videoFilename));
    expect(payload.videoPath.startsWith(BASE.assetDir)).toBe(true);
    expect(payload.videoPath).not.toContain("videobook-source");
    expect(payload.sourceFilename).toBe("original.mp3");
  });

  it("names the transcript component each job fills once the audio hash is known", () => {
    const jobs = plan({ hasOpenAiKey: true, hasElevenLabsKey: true, audioHash: "a".repeat(64) });
    expect(jobs[0].payload.componentKey).toBe(openAiTranscriptKey("a".repeat(64)));
    expect(jobs[1].payload.componentKey).toBe(elevenLabsTranscriptKey("a".repeat(64), DEFAULT_TRANSCRIPT_OPTIONS));
    expect(plan({ hasOpenAiKey: true }).map((job) => job.payload.componentKey)).toEqual([undefined]);
  });

  it("schedules nothing for silent video", () => {
    expect(plan({
      hasAudio: false,
      hasOpenAiKey: true,
      hasElevenLabsKey: true,
    })).toEqual([]);
  });

  it("schedules nothing when skipDownstreamJobs is set", () => {
    expect(plan({
      skipDownstreamJobs: true,
      hasOpenAiKey: true,
      hasElevenLabsKey: true,
    })).toEqual([]);
  });
});

describe("process_video transcript scheduling is shared", () => {
  it("uses the planner instead of an else-if provider fallback", async () => {
    const source = await readFile(join(here, "process-video.ts"), "utf8");
    expect(source).toContain("planVideoTranscriptJobs(");
    expect(source).toContain("enqueueVideoTranscriptJobs(transcriptJobs)");
    expect(source).toContain("!declinesTranscription(original)");
    expect(source).not.toContain('else if (getApiKey("OPENAI_API_KEY"))');
    expect(source).not.toContain("videoPath: activeVideoPath");
  });

  it("keeps upload, download, and generation on process_video without extra transcript scheduling", async () => {
    const files = [
      join(here, "../local-upload.ts"),
      join(here, "process-upload.ts"),
      join(here, "download-video.ts"),
      join(here, "../media/complete.ts"),
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).toContain('type: "process_video"');
      const transcriptTypes = [...source.matchAll(/type:\s*"(transcribe[^"]*)"/g)]
        .map((match) => match[1]);
      expect(transcriptTypes, file).toEqual([]);
    }
  });
});

describe("a video that declines its transcript", () => {
  let root: string;
  let bookDir: string;
  let engine: Engine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-declined-transcript-"));
    bookDir = join(root, "book");
    engine = createEngineForTest(bookDir);
  });

  afterEach(async () => {
    closeEngineForTest(bookDir, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function processed(label: string, provenance: Record<string, unknown>): Promise<{ assetId: string; assetDir: string }> {
    const incoming = join(root, label);
    await mkdir(incoming, { recursive: true });
    const videoPath = await copyVideoFixture({ width: 160, height: 120, durationSec: 1, fps: 12, source: "color", color: "green", audio: { frequency: 330 } }, join(incoming, "original.mp4"));
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const { artifactId: assetId, path: assetDir } = created.value;
    await processVideoFiles(engine, { type: "process_video", videoPath, assetId, assetDir, bookId: engine.book.get().bookId, provenance });
    return { assetId, assetDir };
  }

  async function original(assetId: string): Promise<Record<string, unknown>> {
    const read = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
    if (!read.ok) throw new Error(read.error.message);
    return read.value;
  }

  it("records the decline on a video with sound, keeps it when the video is processed again, and leaves an import transcribable", async () => {
    const made = await processed("short-clip", { model: "fal:minimax/h3-max/reference-to-video", transcribe: false });
    expect(await original(made.assetId)).toMatchObject({ model: "fal:minimax/h3-max/reference-to-video", hasAudio: true, transcribe: false });
    expect(declinesTranscription(await original(made.assetId))).toBe(true);

    await processVideoFiles(engine, {
      type: "process_video",
      videoPath: join(made.assetDir, "original.mp4"),
      assetId: made.assetId,
      assetDir: made.assetDir,
      bookId: engine.book.get().bookId,
      provenance: { origin: "watermark" },
      force: true,
    });
    expect(await original(made.assetId)).toMatchObject({ origin: "watermark", hasAudio: true, transcribe: false });

    const imported = await processed("imported-clip", { origin: "upload" });
    const importedOriginal = await original(imported.assetId);
    expect(importedOriginal).toMatchObject({ origin: "upload", hasAudio: true });
    expect(importedOriginal).not.toHaveProperty("transcribe");
    expect(declinesTranscription(importedOriginal)).toBe(false);
    expect(declinesTranscription(null)).toBe(false);
    expect(declinesTranscription({ transcribe: "false" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planVideoTranscriptJobs,
  type PlanVideoTranscriptJobsInput,
} from "./process-video.js";

const here = dirname(fileURLToPath(import.meta.url));

const BASE: PlanVideoTranscriptJobsInput = {
  skipDownstreamJobs: false,
  hasAudio: true,
  assetId: "artifact-video-1",
  assetDir: "/books/demo/artifacts/artifact-video-1",
  bookId: "book-1",
  videoFilename: "original.mp4",
  identity: "rev-abc",
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

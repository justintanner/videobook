import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../fs.js";
import { runFfmpeg } from "../ffmpeg.js";
import type { JobHandlerContext, LeaseToken } from "../queue.js";
import { registerTranscribeVideoAudioJob, runTranscribeVideoAudio } from "./transcribe-video-audio.js";

function makeContext(): JobHandlerContext {
  let lease: LeaseToken | null = null;
  return {
    signal: new AbortController().signal,
    setLease(token: LeaseToken): void {
      lease = token;
    },
    getOwnerId(): string {
      if (lease?.kind === "owner") return lease.ownerId;
      throw new Error("no owner lease set");
    },
  };
}

describe("transcribe-video-audio job handler", () => {
  it("exports registerTranscribeVideoAudioJob function", () => {
    expect(typeof registerTranscribeVideoAudioJob).toBe("function");
    expect(registerTranscribeVideoAudioJob.length).toBe(1);
  });
});

describe("runTranscribeVideoAudio", () => {
  let fs: Engine;
  let tempDir: string;
  let assetId: string;
  let assetDir: string;
  let savedApiKey: string | undefined;
  const projectSlug = "test-proj";

  beforeEach(async () => {
    savedApiKey = process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-transcribe-test-"));
    fs = createEngineForTest(tempDir);
    const project = await fs.projects.create(projectSlug);
    if (!project.ok) throw new Error(project.error.message);
    const created = await fs.artifacts.create("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.slug;
    const manifest = await fs.files.manifest(assetId, projectSlug);
    if (!manifest.ok) throw new Error(manifest.error.message);
    assetDir = manifest.value.path;
  });

  afterEach(async () => {
    if (savedApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedApiKey;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  function payload() {
    return {
      type: "transcribe_video_audio" as const,
      videoPath: join(assetDir, "original.mp4"),
      assetId,
      assetDir,
      projectSlug,
    };
  }

  it("returns early without touching the asset when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;

    const result = await runTranscribeVideoAudio(fs, payload(), makeContext());

    expect(result).toEqual({ success: false, reason: "OPENAI_API_KEY not set" });
    const work = await fs.jobs.artifactWork.read(projectSlug, assetId);
    expect(work.ok).toBe(true);
    if (work.ok && work.value) expect(work.value.status).not.toBe("error");
  });

  it("soft-fails without marking the asset errored when transcription work throws", async () => {
    // Real-looking key so getApiKey passes it through; the handler fails on
    // the missing original.mp3 before any network call is attempted.
    process.env.OPENAI_API_KEY = "soft-fail-dummy-key";
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.5:r=10",
      "-pix_fmt", "yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast",
      "-movflags", "+faststart",
      join(assetDir, "original.mp4"),
    ]);

    const result = await runTranscribeVideoAudio(fs, payload(), makeContext());

    expect(result.success).toBe(false);
    expect(result.reason).toBeTruthy();

    // The asset must stay clean: lease completed, no persisted error.
    const work = await fs.jobs.artifactWork.read(projectSlug, assetId);
    expect(work.ok).toBe(true);
    if (!work.ok) return;
    expect(work.value?.status).toBe("ready");

    const generationError = await fs.jobs.failures.read(projectSlug, assetId);
    expect(generationError.ok).toBe(true);
    if (generationError.ok) expect(generationError.value).toBeNull();

    const manifest = await fs.files.manifest(assetId, projectSlug);
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      const names = manifest.value.files.map((file) => file.name);
      expect(names).not.toContain(".analysis.gpt4otrans.json");
    }

    // The exact property the bug broke: the asset must be re-claimable.
    const lease = await fs.jobs.artifactWork.begin(projectSlug, assetId, {
      kind: "transcribe",
      ownerKind: "job",
      durationMs: 60_000,
    });
    expect(lease).not.toBeNull();
    if (lease) await fs.jobs.artifactWork.complete(projectSlug, assetId, lease.ownerId);
  });
});

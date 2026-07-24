import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAudioSyncPlan } from "../audio-sync.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { createEngineForTest } from "../fs.js";
import { queue, setEngineRoot } from "../queue.js";
import {
  prepareAudioSyncTranscript,
  registerSyncVideoToAudioJob,
  renderAudioSyncedVideo,
  restoreAudioSyncSnapshot,
  resolveSyncVideoToAudioAnchors,
  validateAudioSyncOutput,
} from "./sync-video-to-audio.js";

const execFileAsync = promisify(execFile);

async function generateMarkedVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=1",
    "-f", "lavfi", "-i", "color=c=green:s=160x90:r=10:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]",
    "-map", "3:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outputPath,
  ]);
}

async function generatePcmVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=160x90:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le",
    "-shortest",
    outputPath,
  ]);
}

async function audioStreamHash(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-map", "0:a:0",
    "-c:a", "copy",
    "-f", "hash",
    "-hash", "sha256",
    "pipe:1",
  ]);
  return stdout.trim();
}

async function rgbAt(filePath: string, seconds: number): Promise<[number, number, number]> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", filePath,
    "-ss", String(seconds),
    "-frames:v", "1",
    "-vf", "scale=1:1",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 });
  const rgb = stdout as unknown as Buffer;
  return [rgb[0], rgb[1], rgb[2]];
}

describe("sync video to audio media rendering", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-job-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exports a one-argument job registration function", () => {
    expect(typeof registerSyncVideoToAudioJob).toBe("function");
    expect(registerSyncVideoToAudioJob.length).toBe(1);
  });

  it("resolves semantic and numeric anchors into one numeric shape", () => {
    const transcript = {
      words: [
        { text: "England", start: 1.2, type: "word" },
        { text: "America", start: 2.2, type: "word" },
      ],
    };
    expect(resolveSyncVideoToAudioAnchors([
      { videoSeconds: 1, audioCue: "england" },
      { videoSeconds: 2, audioSeconds: 2.2 },
    ], transcript)).toEqual([
      { videoSeconds: 1, audioSeconds: 1.2 },
      { videoSeconds: 2, audioSeconds: 2.2 },
    ]);
  });

  it("lands multiple visual anchors while bitstream-copying AAC audio", async () => {
    const inputPath = join(dir, "marked-source.mp4");
    const outputPath = join(dir, "marked-output.mp4");
    await generateMarkedVideo(inputPath);
    const source = await probeVideo(inputPath);
    const plan = createAudioSyncPlan({
      videoDuration: source.videoDuration,
      audioDuration: source.audioDuration!,
      sourceFps: source.fps,
      anchors: [
        { videoSeconds: 1, audioSeconds: 1.2 },
        { videoSeconds: 2, audioSeconds: 2.2 },
      ],
    });

    const mode = await renderAudioSyncedVideo(inputPath, outputPath, plan);
    await validateAudioSyncOutput(inputPath, outputPath, plan);

    expect(mode).toBe("copy");
    expect(await audioStreamHash(outputPath)).toBe(await audioStreamHash(inputPath));
    const beforeFirst = await rgbAt(outputPath, 1.05);
    const afterFirst = await rgbAt(outputPath, 1.35);
    const beforeSecond = await rgbAt(outputPath, 2.05);
    const afterSecond = await rgbAt(outputPath, 2.35);
    expect(beforeFirst[0]).toBeGreaterThan(beforeFirst[1]);
    expect(afterFirst[1]).toBeGreaterThan(afterFirst[0]);
    expect(beforeSecond[1]).toBeGreaterThan(beforeSecond[2]);
    expect(afterSecond[2]).toBeGreaterThan(afterSecond[1]);
  });

  it("falls back to AAC without changing the audio clock", async () => {
    const inputPath = join(dir, "pcm-source.mov");
    const outputPath = join(dir, "pcm-output.mp4");
    await generatePcmVideo(inputPath);
    const source = await probeVideo(inputPath);
    const plan = createAudioSyncPlan({
      videoDuration: source.videoDuration,
      audioDuration: source.audioDuration!,
      sourceFps: source.fps,
      anchors: [{ videoSeconds: 1, audioSeconds: 1.2 }],
    });

    expect(await renderAudioSyncedVideo(inputPath, outputPath, plan)).toBe("aac");
    await validateAudioSyncOutput(inputPath, outputPath, plan);
    expect((await probeVideo(outputPath)).audioCodec).toBe("aac");
  });
});

describe("audio sync transcript preparation and rollback", () => {
  it("uses an existing timed transcript without requesting replacement", async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-transcript-"));
    const fs = createEngineForTest(projectsDir);
    const savedApiKey = process.env.ELEVENLABS_API_KEY;
    try {
      const project = await fs.projects.create("transcript-test");
      if (!project.ok) throw new Error(project.error.message);
      const created = await fs.artifacts.create("vid", "valid transcript", "transcript-test");
      if (!created.ok) throw new Error(created.error.message);
      const audio = await fs.files.write(
        created.value.slug,
        "original.mp3",
        Buffer.from("audio"),
        "transcript-test",
      );
      if (!audio.ok) throw new Error(audio.error.message);
      const transcript = {
        words: [{ text: "England", start: 3.879, type: "word" }],
      };
      const written = await fs.files.write(
        created.value.slug,
        "elevenlabs.json",
        JSON.stringify(transcript),
        "transcript-test",
      );
      if (!written.ok) throw new Error(written.error.message);
      delete process.env.ELEVENLABS_API_KEY;

      await expect(prepareAudioSyncTranscript(
        fs,
        created.value.slug,
        "transcript-test",
      )).resolves.toEqual({ transcript, replacement: null });
    } finally {
      if (savedApiKey === undefined) {
        delete process.env.ELEVENLABS_API_KEY;
      } else {
        process.env.ELEVENLABS_API_KEY = savedApiKey;
      }
      fs.close();
      await rm(projectsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it.each([
    ["absent", null, "original.mp4"],
    ["malformed", "{", "original.mp3"],
    ["empty", JSON.stringify({ words: [] }), "original.mp3"],
    ["untimed", JSON.stringify({ words: [{ text: "England", type: "word" }] }), "original.mp3"],
  ] as const)("requests replacement for an %s transcript without mutating it", async (_name, contents, sourceFilename) => {
    const projectsDir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-replace-"));
    const fs = createEngineForTest(projectsDir);
    const savedApiKey = process.env.ELEVENLABS_API_KEY;
    try {
      const project = await fs.projects.create("replacement-test");
      if (!project.ok) throw new Error(project.error.message);
      const created = await fs.artifacts.create("vid", "replacement transcript", "replacement-test");
      if (!created.ok) throw new Error(created.error.message);
      const audio = await fs.files.write(
        created.value.slug,
        sourceFilename,
        Buffer.from("audio"),
        "replacement-test",
      );
      if (!audio.ok) throw new Error(audio.error.message);
      if (contents !== null) {
        const written = await fs.files.write(
          created.value.slug,
          "elevenlabs.json",
          contents,
          "replacement-test",
        );
        if (!written.ok) throw new Error(written.error.message);
      }
      const historyBefore = await fs.history.artifact(
        created.value.slug,
        "replacement-test",
        20,
      );
      delete process.env.ELEVENLABS_API_KEY;

      await expect(prepareAudioSyncTranscript(
        fs,
        created.value.slug,
        "replacement-test",
      )).rejects.toThrow("ELEVENLABS_API_KEY environment variable is not set");

      const transcriptAfter = await fs.files.read(
        created.value.slug,
        "elevenlabs.json",
        "replacement-test",
      );
      if (contents === null) {
        expect(transcriptAfter.ok).toBe(false);
      } else {
        expect(transcriptAfter.ok).toBe(true);
        if (transcriptAfter.ok) expect(transcriptAfter.value.toString("utf8")).toBe(contents);
      }
      const historyAfter = await fs.history.artifact(
        created.value.slug,
        "replacement-test",
        20,
      );
      expect(historyAfter.map((entry) => entry.hash)).toEqual(
        historyBefore.map((entry) => entry.hash),
      );
    } finally {
      if (savedApiKey === undefined) {
        delete process.env.ELEVENLABS_API_KEY;
      } else {
        process.env.ELEVENLABS_API_KEY = savedApiKey;
      }
      fs.close();
      await rm(projectsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("restores media, transcripts, derivatives, and added files to the checked commit", async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-restore-"));
    const fs = createEngineForTest(projectsDir);
    try {
      const project = await fs.projects.create("restore-test");
      if (!project.ok) throw new Error(project.error.message);
      const created = await fs.artifacts.create("vid", "restore source", "restore-test");
      if (!created.ok) throw new Error(created.error.message);
      for (const [filename, contents] of [
        ["original.mp4", "original media"],
        [".original.json", "{}"],
        ["elevenlabs.json", "original transcript"],
        [".original.analysis.json", "original analysis"],
      ] as const) {
        const written = await fs.files.write(
          created.value.slug,
          filename,
          contents,
          "restore-test",
        );
        if (!written.ok) throw new Error(written.error.message);
      }
      const history = await fs.history.artifact(created.value.slug, "restore-test", 1);
      const restoreCommit = history[0]?.hash;
      if (!restoreCommit) throw new Error("missing restore commit");

      for (const [filename, contents] of [
        ["original.mp4", "changed media"],
        ["elevenlabs.json", "changed transcript"],
        [".suggest-cuts.json", "new derivative"],
      ] as const) {
        const written = await fs.files.write(
          created.value.slug,
          filename,
          contents,
          "restore-test",
        );
        if (!written.ok) throw new Error(written.error.message);
      }
      const deleted = await fs.files.delete(
        created.value.slug,
        ".original.analysis.json",
        "restore-test",
      );
      if (!deleted.ok) throw new Error(deleted.error.message);

      await expect(restoreAudioSyncSnapshot(
        fs,
        created.value.slug,
        "restore-test",
        restoreCommit,
      )).resolves.toMatch(/^[a-f0-9]{40}$/);

      for (const [filename, contents] of [
        ["original.mp4", "original media"],
        ["elevenlabs.json", "original transcript"],
        [".original.analysis.json", "original analysis"],
      ] as const) {
        const restored = await fs.files.read(created.value.slug, filename, "restore-test");
        expect(restored.ok).toBe(true);
        if (restored.ok) expect(restored.value.toString("utf8")).toBe(contents);
      }
      await expect(fs.files.read(
        created.value.slug,
        ".suggest-cuts.json",
        "restore-test",
      )).resolves.toMatchObject({ ok: false });
      await expect(restoreAudioSyncSnapshot(
        fs,
        created.value.slug,
        "restore-test",
        "0000000000000000000000000000000000000000",
      )).rejects.toThrow("ref not found");
      const work = await fs.jobs.artifactWork.read("restore-test", created.value.slug);
      expect(work.ok).toBe(true);
      if (work.ok) expect(work.value?.status).toBe("ready");
    } finally {
      fs.close();
      await rm(projectsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("restores a failed cue job to ready after its lock has been released", async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), "videocity-audio-sync-job-rollback-"));
    const sourcePath = join(projectsDir, "source.mp4");
    await generateMarkedVideo(sourcePath);
    const fs = createEngineForTest(projectsDir);
    await setEngineRoot(projectsDir, fs);
    try {
      const project = await fs.projects.create("job-rollback-test");
      if (!project.ok) throw new Error(project.error.message);
      const created = await fs.artifacts.create("vid", "job rollback", "job-rollback-test");
      if (!created.ok) throw new Error(created.error.message);
      const video = await fs.files.write(
        created.value.slug,
        "original.mp4",
        await readFile(sourcePath),
        "job-rollback-test",
      );
      if (!video.ok) throw new Error(video.error.message);
      const transcriptText = JSON.stringify({
        words: [{ text: "England", start: 1.2, type: "word" }],
      });
      const transcript = await fs.files.write(
        created.value.slug,
        "elevenlabs.json",
        transcriptText,
        "job-rollback-test",
      );
      if (!transcript.ok) throw new Error(transcript.error.message);
      const metadata = await fs.metadata.artifacts.write(
        created.value.slug,
        "original",
        {},
        "job-rollback-test",
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      const historyBefore = await fs.history.artifact(
        created.value.slug,
        "job-rollback-test",
        20,
      );
      registerSyncVideoToAudioJob(fs);

      await expect(queue.enqueueAndWait(
        `sync-audio-rollback-${created.value.slug}`,
        {
          type: "sync_video_to_audio",
          inputPath: join(created.value.path, "original.mp4"),
          outputPath: join(created.value.path, ".sync-audio-rollback.mp4"),
          anchors: [{ videoSeconds: 1, audioCue: "missing cue" }],
          assetId: created.value.slug,
          assetDir: created.value.path,
          projectSlug: "job-rollback-test",
        },
        30_000,
      )).rejects.toThrow("was not found");

      const work = await fs.jobs.artifactWork.read("job-rollback-test", created.value.slug);
      expect(work.ok).toBe(true);
      if (work.ok) expect(work.value?.status).toBe("ready");
      const generationError = await fs.jobs.failures.read(
        "job-rollback-test",
        created.value.slug,
      );
      expect(generationError.ok).toBe(true);
      if (generationError.ok) expect(generationError.value).toBeNull();
      const transcriptAfter = await fs.files.read(
        created.value.slug,
        "elevenlabs.json",
        "job-rollback-test",
      );
      expect(transcriptAfter.ok).toBe(true);
      if (transcriptAfter.ok) expect(transcriptAfter.value.toString("utf8")).toBe(transcriptText);
      const historyAfter = await fs.history.artifact(
        created.value.slug,
        "job-rollback-test",
        20,
      );
      expect(historyAfter.length).toBeGreaterThan(historyBefore.length);
      expect(historyAfter.some((entry) => entry.operation === "restore_artifact"))
        .toBe(true);
      const restoredHashes = new Set(historyAfter.map((entry) => entry.hash));
      for (const entry of historyBefore) {
        expect(restoredHashes.has(entry.hash)).toBe(true);
      }
    } finally {
      await queue.stop();
      fs.close();
      await rm(projectsDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

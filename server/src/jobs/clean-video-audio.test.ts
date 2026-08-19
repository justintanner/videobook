import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import {
  buildCleanAudioFilter,
  renderCleanVideoAudio,
  replaceVideoAssetInPlace,
} from "./clean-video-audio.js";

const execFileAsync = promisify(execFile);

async function streamHash(path: string, stream: "v:0" | "a:0"): Promise<string> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error",
    "-i", path,
    "-map", `0:${stream}`,
    "-c", "copy",
    "-f", "md5",
    "-",
  ]);
  return stdout.trim();
}

describe("clean-video-audio job media mix", () => {
  let tempDir: string;
  let sourcePath: string;
  let voicePath: string;
  let musicPath: string;
  let engineRoot: string | undefined;
  let engine: ReturnType<typeof createEngineForTest> | undefined;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-clean-audio-mix-test-"));
    sourcePath = join(tempDir, "source.mp4");
    voicePath = join(tempDir, "voice.mp3");
    musicPath = join(tempDir, "music.mp3");

    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=12",
      "-f", "lavfi", "-i", "sine=frequency=660:duration=3",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      sourcePath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:a", "libmp3lame",
      voicePath,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=3",
      "-c:a", "libmp3lame",
      musicPath,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (engine && engineRoot) closeEngineForTest(engineRoot, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("builds a denoised, ducked, normalized mix with edge fades", () => {
    const filter = buildCleanAudioFilter({
      durationSeconds: 3,
      sourceMix: 0.22,
      edgeFadeMs: 250,
      musicVolume: 0.08,
      hasMusic: true,
    });

    expect(filter).toContain("afftdn");
    expect(filter).toContain("sidechaincompress");
    expect(filter).toContain("loudnorm");
    expect(filter).toContain("afade=t=in");
    expect(filter).toContain("amix=inputs=3");
  });

  it("copies the video bitstream while replacing the audio mix", async () => {
    const outputPath = join(tempDir, "output.mp4");
    await renderCleanVideoAudio(
      sourcePath,
      voicePath,
      musicPath,
      outputPath,
      {
        durationSeconds: 3,
        sourceMix: 0.22,
        edgeFadeMs: 250,
        musicVolume: 0.08,
        hasMusic: true,
      },
    );

    const outputProbe = await probeVideo(outputPath);
    expect(outputProbe.hasAudio).toBe(true);
    expect(outputProbe.videoCodec).toBe("h264");
    expect(outputProbe.duration).toBeCloseTo(3, 1);
    expect(await streamHash(outputPath, "v:0")).toBe(await streamHash(sourcePath, "v:0"));
    expect(await streamHash(outputPath, "a:0")).not.toBe(await streamHash(sourcePath, "a:0"));
  }, 60_000);

  it("replaces the canonical asset video through videobook-engine", async () => {
    const outputPath = join(tempDir, "replacement.mp4");
    await renderCleanVideoAudio(
      sourcePath,
      voicePath,
      null,
      outputPath,
      {
        durationSeconds: 3,
        sourceMix: 0.22,
        edgeFadeMs: 250,
        musicVolume: 0.08,
        hasMusic: false,
      },
    );

    engineRoot = join(tempDir, "projects");
    engine = createEngineForTest(engineRoot);
    const fs = engine;
    const asset = await fs.artifacts.create("vid", "source");
    if (!asset.ok) throw new Error(asset.error.message);
    const sourceWrite = await fs.files.write(asset.value.artifactId, "original.mp4", await readFile(sourcePath)
    );
    if (!sourceWrite.ok) throw new Error(sourceWrite.error.message);
    const historyBefore = fs.history.artifact(asset.value.artifactId);

    await replaceVideoAssetInPlace(
      fs,
      asset.value.artifactId,
      "original.mp4",
      outputPath,
    );

    const stored = await fs.files.read(asset.value.artifactId, "original.mp4");
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value.equals(await readFile(outputPath))).toBe(true);
    expect(fs.history.artifact(asset.value.artifactId).length).toBeGreaterThan(historyBefore.length);
  }, 60_000);
});

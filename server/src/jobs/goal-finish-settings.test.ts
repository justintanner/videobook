import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import type { GoalFinishRecipe, GoalSoundtrack } from "../goal-finish-model.js";
import { goalBrandingDocument } from "../goal-finish-model.js";
import { assertGoalFinishRecipe, renderGoalFinishAudio, renderGoalFinishBranding } from "../goal-finish-render.js";
import { captureGoalBranding, goalSoundtrackSource } from "../goal-finish-settings.js";
import { graphicsDocumentFromLayers } from "../graphics/model.js";
import { saveGraphicsTemplate, setDefaultGraphicsTemplate, setWatermarkGraphicsTemplate } from "../graphics/templates.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { testBudget } from "../test-budget.js";
import { copyVideoFixture } from "../test-media-fixtures.js";
import { cleanupSource } from "../video-cleanup/source.js";
import { saveWatermarkProfile } from "../watermark-config.js";

const execFileAsync = promisify(execFile);
const signal = () => new AbortController().signal;

async function audioAt(path: string, seconds: number) {
  const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-ss", String(seconds), "-i", path, "-t", "0.125", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", timeout: testBudget(30_000) });
  const samples = Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4));
  const amplitude = (frequency: number) => {
    const real = samples.reduce((sum, value, index) => sum + value * Math.cos(2 * Math.PI * frequency * index / 48000), 0);
    const imaginary = samples.reduce((sum, value, index) => sum + value * Math.sin(2 * Math.PI * frequency * index / 48000), 0);
    return 2 * Math.hypot(real, imaginary) / samples.length;
  };
  return { amplitude, rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) };
}

async function centerPixel(path: string, seconds: number): Promise<number[]> {
  const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-ss", String(seconds), "-i", path, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", timeout: testBudget(30_000) });
  return [...stdout];
}

describe("saved goal sound and branding", () => {
  let root: string;
  let engine: Engine;
  let source: GoalSoundtrack;
  let clipPath: string;

  async function importVideo(path: string) {
    const artifact = await engine.artifacts.create("video", "Finish input");
    if (!artifact.ok) throw new Error(artifact.error.message);
    const id = artifact.value.artifactId;
    const written = await engine.files.writeFromPath(id, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, id, "original.mp4", await probeVideo(path), { transcribe: false });
    return id;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-finish-settings-"));
    engine = createEngineForTest(join(root, "book"));
    clipPath = join(root, "clip.mp4");
    await copyVideoFixture({ width: 180, height: 320, durationSec: 4, fps: 12, source: "color", color: "blue", audio: { frequency: 880 } }, clipPath);
    const path = join(root, "source.mp4");
    await execFileAsync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=green:size=180x320:rate=12:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=1:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=660:duration=2:sample_rate=48000",
      "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[outa]", "-map", "0:v", "-map", "[outa]", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-threads", "2", path], { timeout: testBudget(60_000) });
    const artifactId = await importVideo(path);
    const media = await goalSoundtrackSource(engine, artifactId);
    source = { artifactId, mediaHash: media.mediaHash, durationSeconds: media.durationSeconds, hasAudio: true, startSeconds: 0 };
  });

  afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  it("maps source time, removes generated sound, pads a short track and leaves the selected video intact", async () => {
    const id = await importVideo(clipPath);
    const original = await cleanupSource(engine, source.artifactId);
    await renderGoalFinishAudio(engine, id, { version: 1, audio: "source", branding: null, soundtrack: { ...source, startSeconds: 0.75 } }, signal());
    const output = await cleanupSource(engine, id);
    const beginning = await audioAt(output.path, 0.05);
    expect(beginning.amplitude(330)).toBeGreaterThan(0.07);
    expect(beginning.amplitude(880)).toBeLessThan(0.01);
    expect((await audioAt(output.path, 0.6)).amplitude(660)).toBeGreaterThan(0.07);
    expect((await audioAt(output.path, 3.5)).rms).toBeLessThan(0.001);
    expect(await probeVideo(output.path)).toMatchObject({ videoDuration: 4, audioDuration: 4, fps: 12, width: 180, height: 320 });
    expect((await cleanupSource(engine, source.artifactId)).mediaHash).toBe(original.mediaHash);
    expect((await centerPixel(output.path, 3.5))[2]).toBeGreaterThan(240);
  });

  it("uses explicit mix, generated and muted routing without a transcription or extraction job", async () => {
    for (const audio of ["mix", "generated", "mute"] as const) {
      const id = await importVideo(clipPath);
      const before = await cleanupSource(engine, id);
      const recipe: GoalFinishRecipe = { version: 1, audio, branding: null, soundtrack: source };
      await renderGoalFinishAudio(engine, id, recipe, signal());
      const output = await cleanupSource(engine, id);
      if (audio === "mute") expect(output.hasAudio).toBe(false);
      else {
        const sample = await audioAt(output.path, 0.25);
        expect(sample.amplitude(880)).toBeGreaterThan(0.07);
        if (audio === "mix") expect(sample.amplitude(330)).toBeGreaterThan(0.07);
        else {
          expect(sample.amplitude(330)).toBeLessThan(0.01);
          expect(output.mediaHash).toBe(before.mediaHash);
        }
      }
    }
    expect(engine.jobs.queue.list()).toHaveLength(0);
    await expect(assertGoalFinishRecipe(engine, { version: 1, audio: "source", soundtrack: null, branding: null })).rejects.toThrow("has no audio");
    await expect(assertGoalFinishRecipe(engine, { version: 1, audio: "source", soundtrack: { ...source, mediaHash: "changed" }, branding: null })).rejects.toThrow("soundtrack changed");
  });

  it("preserves a soundtrack stream's original delay instead of moving its first sound to time zero", async () => {
    const delayedPath = join(root, "delayed.mp4");
    await execFileAsync(FFMPEG, ["-v", "error", "-y", "-i", clipPath, "-itsoffset", "1", "-f", "lavfi", "-i", "sine=frequency=330:duration=2:sample_rate=48000",
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", delayedPath], { timeout: testBudget(30_000) });
    const artifactId = await importVideo(delayedPath);
    const media = await goalSoundtrackSource(engine, artifactId);
    const id = await importVideo(clipPath);
    await renderGoalFinishAudio(engine, id, { version: 1, audio: "source", branding: null,
      soundtrack: { artifactId, mediaHash: media.mediaHash, durationSeconds: media.durationSeconds, hasAudio: true, startSeconds: 0 } }, signal());
    const output = await cleanupSource(engine, id);
    expect((await audioAt(output.path, 0.3)).rms).toBeLessThan(0.001);
    expect((await audioAt(output.path, 1.3)).amplitude(330)).toBeGreaterThan(0.07);
    expect((await audioAt(output.path, 3.5)).rms).toBeLessThan(0.001);
  });

  it("draws every saved template image at its accepted time and freezes the look, handle and title slots", async () => {
    const image = await engine.artifacts.create("image", "Accepted stamp");
    if (!image.ok) throw new Error(image.error.message);
    const imageId = image.value.artifactId;
    const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } }).png().toBuffer();
    await engine.files.write(imageId, "original.png", red);
    const document = graphicsDocumentFromLayers([
      { kind: "image", artifactId: imageId, position: { anchor: "center", x: 0.5, y: 0.5, space: "frame" }, size: 0.3, timing: { start: 1, end: 2, fade: 0 } },
      { kind: "text", items: [{ slot: "headline", text: "Tentative old title" }], position: { anchor: "top", x: 0.5, y: 0.1, space: "frame" } },
    ]);
    const template = await saveGraphicsTemplate(engine, { name: "Reviewed finish", document });
    await setWatermarkGraphicsTemplate(engine, "tiktok", template.id);
    await saveWatermarkProfile({ handle: "reviewed_handle" }, "tiktok", engine);
    const branding = await captureGoalBranding(engine, source.artifactId);
    await saveGraphicsTemplate(engine, { templateId: template.id, name: "New book look", document: graphicsDocumentFromLayers([]) });
    await saveWatermarkProfile({ handle: "later_handle" }, "tiktok", engine);
    const title = { headline: "Reviewed title", secondary: "" };
    const frozen = goalBrandingDocument(branding, title, 4, { width: 180, height: 320 });
    expect(JSON.stringify(frozen)).toContain("Reviewed title");
    expect(JSON.stringify(frozen)).not.toContain("Tentative old title");
    expect(branding.profile.handle).toBe("reviewed_handle");
    expect((await captureGoalBranding(engine, null)).profile.handle).toBe("later_handle");
    const id = await importVideo(clipPath);
    await renderGoalFinishBranding(engine, id, branding, title, signal());
    const output = await cleanupSource(engine, id);
    expect((await centerPixel(output.path, 0.5))[2]).toBeGreaterThan(240);
    const during = await centerPixel(output.path, 1.5);
    expect(during[0]).toBeGreaterThan(230);
    expect(during[2]).toBeLessThan(20);
    expect((await centerPixel(output.path, 2.5))[2]).toBeGreaterThan(240);
    const other = createEngineForTest(join(root, "other-book"));
    expect((await captureGoalBranding(other, null)).template).toBeNull();
    await setWatermarkGraphicsTemplate(engine, "tiktok", null);
    await setDefaultGraphicsTemplate(engine, "headline");
    expect((await captureGoalBranding(engine, null)).starterId).toBe("headline");
    await engine.files.write(imageId, "original.png", await sharp(red).negate().png().toBuffer());
    await expect(renderGoalFinishBranding(engine, id, branding, title, signal())).rejects.toThrow("saved branding changed");
    expect(engine.jobs.queue.list()).toHaveLength(0);
  }, testBudget(90_000));
});

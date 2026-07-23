import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { VideocityFs } from "videobook-engine";
import { createFsForTest } from "../fs.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, waitForJob } from "../queue.js";
import { buildOutroSpec } from "../remotion/qr-outro-spec.js";
import { createTestClient } from "../test-client.js";

const PROJECT = "qr-outro-e2e";

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text) as Record<string, unknown>;
}

function createImpactWav(): Buffer {
  const sampleRate = 48_000;
  const sampleCount = Math.round(sampleRate * 0.18);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const decay = Math.exp(-time * 22);
    const wave = Math.sin(time * Math.PI * 2 * 120) * 0.65
      + Math.sin(time * Math.PI * 2 * 930) * 0.25;
    buffer.writeInt16LE(Math.round(wave * decay * 28_000), 44 + index * 2);
  }
  return buffer;
}

async function createImage(
  fs: VideocityFs,
  name: string,
  width: number,
  height: number,
  color: string,
): Promise<string> {
  const asset = await fs.createAsset("img", name, PROJECT);
  if (!asset.ok) throw new Error(asset.error.message);
  const image = await sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer();
  const written = await fs.writeFile(asset.value.assetId, "original.png", image, PROJECT);
  if (!written.ok) throw new Error(written.error.message);
  return asset.value.assetId;
}

async function createAudio(fs: VideocityFs): Promise<string> {
  const asset = await fs.createAsset("aud", "impact", PROJECT);
  if (!asset.ok) throw new Error(asset.error.message);
  const written = await fs.writeFile(
    asset.value.assetId,
    "original.wav",
    createImpactWav(),
    PROJECT,
  );
  if (!written.ok) throw new Error(written.error.message);
  return asset.value.assetId;
}

async function extractFrame(videoPath: string, seconds: number, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-y",
    "-ss", String(seconds),
    "-i", videoPath,
    "-frames:v", "1",
    outputPath,
  ]);
}

async function pixelAt(imagePath: string, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function rmsAt(pcm: Buffer, startSeconds: number, endSeconds: number): number {
  const sampleRate = 48_000;
  const first = Math.floor(startSeconds * sampleRate);
  const last = Math.min(Math.floor(endSeconds * sampleRate), pcm.length / 4);
  let sum = 0;
  for (let index = first; index < last; index += 1) {
    const value = pcm.readFloatLE(index * 4);
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, last - first));
}

describe("create_qr_outro e2e", () => {
  let client: Client;
  let fs: VideocityFs;
  let tempDir: string;
  let outputAssetId: string;
  let outputPath: string;
  let defaultSoundOutputAssetId: string;
  let defaultSoundOutputPath: string;
  let silentOutputAssetId: string;
  let silentOutputPath: string;
  let qrOne: string;
  let qrTwo: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-qr-outro-e2e-"));
    client = await createTestClient(tempDir);
    fs = createFsForTest(tempDir);
    const project = await fs.createProject(PROJECT);
    if (!project.ok) throw new Error(project.error.message);

    qrOne = await createImage(fs, "red-qr", 512, 512, "#ef2020");
    qrTwo = await createImage(fs, "green-qr", 512, 512, "#20d050");
    const sound = await createAudio(fs);

    const result = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [`@${qrOne}`, `@${qrTwo}`],
        sound_effect_slug: `@${sound}`,
        aspect_ratio: "16:9",
      },
    });
    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    outputAssetId = String(data.asset_id);
    await waitForJob(String(data.job_id), 600_000);

    const manifest = await fs.getManifest(outputAssetId, PROJECT);
    if (!manifest.ok) throw new Error(manifest.error.message);
    outputPath = join(manifest.value.path, "original.mp4");

    const defaultSoundResult = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [qrOne],
        aspect_ratio: "1:1",
      },
    });
    expect(defaultSoundResult.isError).toBeFalsy();
    const defaultSoundData = parseResult(defaultSoundResult);
    expect(defaultSoundData.sound_effect_source).toBe("bundled_default");
    defaultSoundOutputAssetId = String(defaultSoundData.asset_id);
    await waitForJob(String(defaultSoundData.job_id), 600_000);
    const defaultSoundManifest = await fs.getManifest(defaultSoundOutputAssetId, PROJECT);
    if (!defaultSoundManifest.ok) throw new Error(defaultSoundManifest.error.message);
    defaultSoundOutputPath = join(defaultSoundManifest.value.path, "original.mp4");

    const silentResult = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [qrOne],
        aspect_ratio: "16:9",
        duration_seconds: 10,
        include_audio: false,
      },
    });
    expect(silentResult.isError).toBeFalsy();
    const silentData = parseResult(silentResult);
    expect(silentData).toMatchObject({
      duration_seconds: 10,
      include_audio: false,
      sound_effect_source: "none",
    });
    silentOutputAssetId = String(silentData.asset_id);
    await waitForJob(String(silentData.job_id), 600_000);
    const silentManifest = await fs.getManifest(silentOutputAssetId, PROJECT);
    if (!silentManifest.ok) throw new Error(silentManifest.error.message);
    silentOutputPath = join(silentManifest.value.path, "original.mp4");
  }, 900_000);

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    fs?.close();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("renders a processed 16:9 video with audio", async () => {
    const probe = await probeVideo(outputPath);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.fps).toBeCloseTo(30, 1);
    expect(probe.duration).toBeGreaterThanOrEqual(2.9);
    expect(probe.duration).toBeLessThanOrEqual(3.15);
    expect(probe.hasAudio).toBe(true);

    const manifest = await fs.getManifest(outputAssetId, PROJECT);
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(manifest.value.files.map((file) => file.name)).toEqual(
      expect.arrayContaining(["original.mp4", "original.mp3", "original.jpg"]),
    );
    const status = await fs.getAssetStatus(outputAssetId, PROJECT);
    expect(status.ok && status.value).toBe("ready");
  });

  it("persists complete source and timing provenance", async () => {
    const metadata = await fs.readMetadata<Record<string, unknown>>(
      outputAssetId,
      "qr-outro",
      PROJECT,
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    expect(metadata.value).toMatchObject({
      origin: "create_qr_outro",
      qr_image_slugs: [qrOne, qrTwo],
      sound_effect_slug: expect.stringMatching(/^aud-/),
      sound_effect_source: "asset",
      aspect_ratio: "16:9",
      fps: 30,
      duration_seconds: 3,
      impact_frames: [12, 24],
    });

    const original = await fs.readMetadata<Record<string, unknown>>(
      outputAssetId,
      "original",
      PROJECT,
    );
    if (!original.ok) throw new Error(original.error.message);
    expect(original.value).toMatchObject({
      origin: "create_qr_outro",
      aspect_ratio: "16:9",
      width: 1920,
      height: 1080,
      hasAudio: true,
    });
  });

  it("renders with the bundled sound when no audio asset is supplied", async () => {
    const probe = await probeVideo(defaultSoundOutputPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1080);
    expect(probe.hasAudio).toBe(true);
    const metadata = await fs.readMetadata<Record<string, unknown>>(
      defaultSoundOutputAssetId,
      "qr-outro",
      PROJECT,
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    expect(metadata.value).toMatchObject({
      sound_effect_slug: null,
      sound_effect_source: "bundled_default",
      sound_effect_filename: "qr-outro-impact.wav",
    });
    const pcmPath = join(tempDir, "default-outro-audio.f32le");
    await runFfmpeg([
      "-y",
      "-i", defaultSoundOutputPath,
      "-map", "0:a:0",
      "-ac", "1",
      "-ar", "48000",
      "-f", "f32le",
      pcmPath,
    ]);
    const pcm = await readFile(pcmPath);
    expect(rmsAt(pcm, 0.42, 0.52)).toBeGreaterThan(0.01);
    expect(rmsAt(pcm, 1.4, 1.5)).toBeLessThan(0.005);
    const status = await fs.getAssetStatus(defaultSoundOutputAssetId, PROJECT);
    expect(status.ok && status.value).toBe("ready");
  });

  it("renders a silent ten-second outro and keeps the QR visible", async () => {
    const probe = await probeVideo(silentOutputPath);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.duration).toBeGreaterThanOrEqual(9.9);
    expect(probe.duration).toBeLessThanOrEqual(10.15);
    expect(probe.hasAudio).toBe(false);

    const manifest = await fs.getManifest(silentOutputAssetId, PROJECT);
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(manifest.value.files.map((file) => file.name)).not.toContain("original.mp3");

    const metadata = await fs.readMetadata<Record<string, unknown>>(
      silentOutputAssetId,
      "qr-outro",
      PROJECT,
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    expect(metadata.value).toMatchObject({
      sound_effect_slug: null,
      sound_effect_source: "none",
      sound_effect_filename: null,
      include_audio: false,
      duration_seconds: 10,
    });

    const finalFramePath = join(tempDir, "silent-final-frame.png");
    await extractFrame(silentOutputPath, 9.5, finalFramePath);
    const spec = buildOutroSpec("16:9", 1, 10);
    const center = spec.cards[0];
    const pixel = await pixelAt(
      finalFramePath,
      Math.floor(center.x + center.w / 2),
      Math.floor(center.y + center.h / 2),
    );
    expect(pixel[0]).toBeGreaterThan(180);
    expect(pixel[1]).toBeLessThan(90);
    expect(pixel[2]).toBeLessThan(90);
  });

  it("lands every QR input one at a time across the full canvas", async () => {
    const spec = buildOutroSpec("16:9", 2);
    const centers = spec.cards.map((card) => ({
      x: Math.floor(card.x + card.w / 2),
      y: Math.floor(card.y + card.h / 2),
    }));
    const beforePath = join(tempDir, "before.png");
    const firstPath = join(tempDir, "first.png");
    const secondPath = join(tempDir, "second.png");
    await extractFrame(outputPath, 0.1, beforePath);
    await extractFrame(outputPath, 0.5, firstPath);
    await extractFrame(outputPath, 0.9, secondPath);

    const beforeFirst = await pixelAt(beforePath, centers[0].x, centers[0].y);
    const afterFirst = await pixelAt(firstPath, centers[0].x, centers[0].y);
    const beforeSecond = await pixelAt(firstPath, centers[1].x, centers[1].y);
    const afterSecond = await pixelAt(secondPath, centers[1].x, centers[1].y);

    expect(Math.max(...beforeFirst)).toBeLessThan(35);
    expect(afterFirst[0]).toBeGreaterThan(180);
    expect(afterFirst[1]).toBeLessThan(90);
    expect(Math.max(...beforeSecond)).toBeLessThan(35);
    expect(afterSecond[1]).toBeGreaterThan(150);
    expect(afterSecond[0]).toBeLessThan(100);
  });

  it("renders QR source pixels without card borders", async () => {
    const spec = buildOutroSpec("16:9", 2);
    const settledPath = join(tempDir, "settled-borderless.png");
    await extractFrame(outputPath, 1.1, settledPath);

    const firstEdge = await pixelAt(
      settledPath,
      spec.cards[0].x + 12,
      spec.cards[0].y + 12,
    );
    const secondEdge = await pixelAt(
      settledPath,
      spec.cards[1].x + 12,
      spec.cards[1].y + 12,
    );

    expect(firstEdge[0]).toBeGreaterThan(180);
    expect(firstEdge[1]).toBeLessThan(90);
    expect(firstEdge[2]).toBeLessThan(90);
    expect(secondEdge[1]).toBeGreaterThan(150);
    expect(secondEdge[0]).toBeLessThan(100);
    expect(secondEdge[2]).toBeLessThan(100);
  });

  it("places an impact sound at each QR landing", async () => {
    const pcmPath = join(tempDir, "outro-audio.f32le");
    await runFfmpeg([
      "-y",
      "-i", outputPath,
      "-map", "0:a:0",
      "-ac", "1",
      "-ar", "48000",
      "-f", "f32le",
      pcmPath,
    ]);
    const pcm = await readFile(pcmPath);
    expect(rmsAt(pcm, 0.42, 0.52)).toBeGreaterThan(0.02);
    expect(rmsAt(pcm, 0.82, 0.92)).toBeGreaterThan(0.02);
    expect(rmsAt(pcm, 1.4, 1.5)).toBeLessThan(0.005);
  });

  it("rejects invalid MCP inputs without creating output assets", async () => {
    const before = await fs.listAssets(PROJECT);
    const noQr = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [],
      },
    });
    const tooMany = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [qrOne, qrOne, qrOne, qrOne, qrOne],
      },
    });
    const invalidRatio = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [qrOne],
        aspect_ratio: "4:3",
      },
    });
    const invalidAudio = await client.callTool({
      name: "create_qr_outro",
      arguments: {
        project_slug: PROJECT,
        qr_image_slugs: [qrOne],
        sound_effect_slug: qrTwo,
      },
    });

    expect(noQr.isError).toBe(true);
    expect(tooMany.isError).toBe(true);
    expect(invalidRatio.isError).toBe(true);
    expect(invalidAudio.isError).toBe(true);
    expect(await fs.listAssets(PROJECT)).toHaveLength(before.length);
  });

  it("marks a failed render asset as error", async () => {
    const output = await fs.createAsset("vid", "broken-qr-outro", PROJECT);
    if (!output.ok) throw new Error(output.error.message);
    const jobId = `broken-qr-outro-${Date.now()}`;
    await queue.enqueue(jobId, {
      type: "render_qr_outro",
      projectSlug: PROJECT,
      assetId: output.value.assetId,
      orientation: "landscape",
      qrImages: [{ assetId: "img-missing", filename: "original.png" }],
      soundEffect: null,
      aspectRatio: "16:9",
    });

    await expect(waitForJob(jobId, 60_000)).rejects.toThrow("Failed to read");
    const status = await fs.getAssetStatus(output.value.assetId, PROJECT);
    expect(status.ok && status.value).toBe("error");
  });

  it("does not alter timeline slots", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: PROJECT },
    });
    expect(result.isError).toBeFalsy();
    expect(parseResult(result).slots).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import { queue, setEngineRoot } from "../queue.js";
import { createQrOutroDef } from "./create-qr-outro.js";

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("create_qr_outro", () => {
  let tempDir: string;
  let fs: Engine;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-qr-outro-tool-"));
    fs = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, fs);
    bookId = fs.book.get().bookId;
  });

  afterEach(async () => {
    await queue.stop();
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createImage(name: string, color: string): Promise<string> {
    const asset = await fs.artifacts.create("img", name);
    if (!asset.ok) throw new Error(asset.error.message);
    const png = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: color,
      },
    }).png().toBuffer();
    const written = await fs.files.write(asset.value.artifactId, "original.png", png);
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.artifactId;
  }

  async function createAudio(name: string): Promise<string> {
    const asset = await fs.artifacts.create("aud", name);
    if (!asset.ok) throw new Error(asset.error.message);
    const written = await fs.files.write(asset.value.artifactId, "original.wav", Buffer.from("RIFF0000WAVE")
    );
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.artifactId;
  }

  it("normalizes references and queues a portrait render", async () => {
    const qrOne = await createImage("qr-one", "#ffffff");
    const qrTwo = await createImage("qr-two", "#000000");
    const sound = await createAudio("slap");

    const result = await createQrOutroDef(fs).handler({
      book_id: bookId,
      qr_image_refs: [`@${qrOne}`, qrTwo],
      sound_effect_ref: `@${sound}`,
      aspect_ratio: "9:16",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data).toMatchObject({
      status: "enqueued",
      aspect_ratio: "9:16",
      duration_seconds: 3,
      qr_image_refs: [qrOne, qrTwo],
      sound_effect_ref: sound,
      sound_effect_source: "asset",
    });
    const outro = fs.artifacts.get(String(data.asset_id));
    expect(outro.ok && outro.value.kind).toBe("video");
    expect(outro.ok && outro.value.label).toBe(`qr-outro-${qrOne}`);
    expect(data.job_id).toMatch(/^render-qr-outro-/);

    const status = await fs.status.get(String(data.asset_id));
    expect(status.ok && status.value).toBe("render-queued-portrait");
  });

  it("defaults to 16:9 and the bundled sound", async () => {
    const qr = await createImage("qr", "#ffffff");

    const result = await createQrOutroDef(fs).handler({
      book_id: bookId,
      qr_image_refs: [qr],
    });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      aspect_ratio: "16:9",
      duration_seconds: 3,
      qr_image_refs: [qr],
      sound_effect_source: "bundled_default",
    });
    expect(parseResult(result)).not.toHaveProperty("sound_effect_ref");
  });

  it("queues a silent ten-second outro", async () => {
    const qr = await createImage("silent-qr", "#ffffff");

    const result = await createQrOutroDef(fs).handler({
      book_id: bookId,
      qr_image_refs: [qr],
      duration_seconds: 10,
      include_audio: false,
    });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      duration_seconds: 10,
      include_audio: false,
      sound_effect_source: "none",
    });
    expect(parseResult(result)).not.toHaveProperty("sound_effect_ref");
  });

  it("rejects an audio override for a silent outro", async () => {
    const qr = await createImage("silent-qr", "#ffffff");
    const sound = await createAudio("slap");

    const result = await createQrOutroDef(fs).handler({
      book_id: bookId,
      qr_image_refs: [qr],
      sound_effect_ref: sound,
      include_audio: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("sound_effect_ref cannot be used");
  });

  it("rejects missing media files before creating an output", async () => {
    const empty = await fs.artifacts.create("img", "empty-qr");
    if (!empty.ok) throw new Error(empty.error.message);
    const before = await fs.artifacts.list();

    const result = await createQrOutroDef(fs).handler({
      book_id: bookId,
      qr_image_refs: [empty.value.artifactId],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No image file found");
    expect(await fs.artifacts.list()).toHaveLength(before.length);
  });

  it("rejects references with the wrong asset type", async () => {
    const sound = await createAudio("sound");

    const result = await createQrOutroDef(fs).handler({
      book_id: bookId,
      qr_image_refs: [sound],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be an image artifact");
  });
});

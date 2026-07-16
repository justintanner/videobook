import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { VideocityFs } from "videocity-engine";
import { createFsForTest } from "../fs.js";
import { queue, setProjectsDir } from "../queue.js";
import { createQrOutroDef } from "./create-qr-outro.js";

const PROJECT = "qr-outro-test";

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("create_qr_outro", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-qr-outro-tool-"));
    await setProjectsDir(tempDir);
    fs = createFsForTest(tempDir);
    const project = await fs.createProject(PROJECT);
    expect(project.ok).toBe(true);
  });

  afterEach(async () => {
    await queue.stop();
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createImage(name: string, color: string): Promise<string> {
    const asset = await fs.createAsset("img", name, PROJECT);
    if (!asset.ok) throw new Error(asset.error.message);
    const png = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: color,
      },
    }).png().toBuffer();
    const written = await fs.writeFile(asset.value.assetId, "original.png", png, PROJECT);
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.assetId;
  }

  async function createAudio(name: string): Promise<string> {
    const asset = await fs.createAsset("aud", name, PROJECT);
    if (!asset.ok) throw new Error(asset.error.message);
    const written = await fs.writeFile(
      asset.value.assetId,
      "original.wav",
      Buffer.from("RIFF0000WAVE"),
      PROJECT,
    );
    if (!written.ok) throw new Error(written.error.message);
    return asset.value.assetId;
  }

  it("normalizes references and queues a portrait render", async () => {
    const qrOne = await createImage("qr-one", "#ffffff");
    const qrTwo = await createImage("qr-two", "#000000");
    const sound = await createAudio("slap");

    const result = await createQrOutroDef(fs).handler({
      project_slug: PROJECT,
      qr_image_slugs: [`@${qrOne}`, qrTwo],
      sound_effect_slug: `@${sound}`,
      aspect_ratio: "9:16",
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data).toMatchObject({
      status: "enqueued",
      aspect_ratio: "9:16",
      duration_seconds: 3,
      qr_image_slugs: [qrOne, qrTwo],
      sound_effect_slug: sound,
      sound_effect_source: "asset",
    });
    expect(data.asset_id).toBe("vid-qr-outro-qr-one");
    expect(data.job_id).toMatch(/^render-qr-outro-/);

    const status = await fs.getAssetStatus(String(data.asset_id), PROJECT);
    expect(status.ok && status.value).toBe("render-queued-portrait");
  });

  it("defaults to 16:9 and the bundled sound", async () => {
    const qr = await createImage("qr", "#ffffff");

    const result = await createQrOutroDef(fs).handler({
      project_slug: PROJECT,
      qr_image_slugs: [qr],
    });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toMatchObject({
      aspect_ratio: "16:9",
      duration_seconds: 3,
      qr_image_slugs: [qr],
      sound_effect_source: "bundled_default",
    });
    expect(parseResult(result)).not.toHaveProperty("sound_effect_slug");
  });

  it("rejects missing media files before creating an output", async () => {
    const empty = await fs.createAsset("img", "empty-qr", PROJECT);
    if (!empty.ok) throw new Error(empty.error.message);
    const before = await fs.listAssets(PROJECT);

    const result = await createQrOutroDef(fs).handler({
      project_slug: PROJECT,
      qr_image_slugs: [empty.value.assetId],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No image file found");
    expect(await fs.listAssets(PROJECT)).toHaveLength(before.length);
  });

  it("rejects references with the wrong asset type", async () => {
    const sound = await createAudio("sound");

    const result = await createQrOutroDef(fs).handler({
      project_slug: PROJECT,
      qr_image_slugs: [sound],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be an img-* asset");
  });
});

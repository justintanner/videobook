import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import type { GraphicsDocument, GraphicsLayerInput } from "../graphics/model.js";
import { appendGraphicsLayers } from "../graphics/model.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";

const execFileAsync = promisify(execFile);
const SMALL = { width: 360, height: 640 };
const SECONDS = 4;
const MAGENTA = [255, 0, 255] as const;
const BRAND: GraphicsLayerInput = {
  kind: "text",
  name: "Brand",
  position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
  width: 0.9,
  align: "left",
  plate: { color: "#FF00FF", opacity: 1, radius: 0 },
  items: [{ text: "Follow for more", size: 0.04, shadow: false }],
};

type TextContent = Array<{ type: string; text: string }>;
type Frame = { width: number; height: number };
type Read = { revision: string; document: GraphicsDocument; source: { source_hash: string }; render: { status: string; error: string | null } | null; burned: { output: string } | null };

async function frameAt(path: string, seconds: number, frame: Frame): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-v", "error", "-ss", seconds.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: frame.width * frame.height * 4 });
  return stdout;
}

function meanDifference(left: Buffer, right: Buffer): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

function colorCount(pixels: Buffer, target: readonly [number, number, number], tolerance: number): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 3) {
    if (Math.abs(pixels[offset] - target[0]) + Math.abs(pixels[offset + 1] - target[1]) + Math.abs(pixels[offset + 2] - target[2]) <= tolerance) count += 1;
  }
  return count;
}

describe("the graphics editor's watermark mode burns what apply_watermark burns", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let clips = 0;
  const bookId = "graphics-watermark-e2e";

  beforeEach(async () => {
    originalEnv = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.X_ACCESS_TOKEN;
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-watermark-e2e-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  afterEach(async () => {
    await client?.close();
    process.env = originalEnv;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text) as T;
  }

  async function videoPath(assetId: string): Promise<string> {
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = findVideoFile(manifest.value.files);
    if (!file) throw new Error(`no video in ${assetId}`);
    return join(manifest.value.path, file.name);
  }

  async function twins(): Promise<{ sourcePath: string; editorId: string; applyId: string }> {
    clips += 1;
    const sourcePath = join(tempDir, `grey-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x808080:s=${SMALL.width}x${SMALL.height}:r=24:d=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${SECONDS}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath,
    ]);
    const bytes = await readFile(sourcePath);
    const [editorId, applyId] = await Promise.all(["editor", "apply"].map(async (label) => {
      const created = await engine.artifacts.create("video", `${label}-${clips}`);
      if (!created.ok) throw new Error(created.error.message);
      const written = await engine.files.write(created.value.artifactId, "original.mp4", bytes);
      if (!written.ok) throw new Error(written.error.message);
      await registerMediaProbe(engine, created.value.artifactId, "original.mp4", await probeVideo(await videoPath(created.value.artifactId)));
      return created.value.artifactId;
    }));
    return { sourcePath, editorId, applyId };
  }

  async function waitReady(assetId: string): Promise<void> {
    const ready = await client.callTool({ name: "wait_for_asset_ready", arguments: { book_id: bookId, asset_id: assetId, timeout_seconds: 240 } });
    expect(ready.isError, JSON.stringify(ready)).toBeFalsy();
  }

  async function renderInPlace(assetId: string, platform: string, revision?: string): Promise<void> {
    const read = await call<Read>("video_graphics", { asset_id: assetId, watermark: true, platform });
    await call("video_graphics", {
      asset_id: assetId,
      watermark: true,
      platform,
      op: "render",
      output: "replace",
      expected_revision: revision ?? read.revision,
      source_hash: read.source.source_hash,
      request_id: randomUUID(),
    });
    await expect.poll(async () => {
      const render = (await call<Read>("video_graphics", { asset_id: assetId, watermark: true, platform })).render;
      return `${render?.status}:${render?.error ?? ""}`;
    }, { timeout: testBudget(180_000), interval: 500 }).toBe("completed:");
    await waitReady(assetId);
  }

  async function expectTwinFrames(editorId: string, applyId: string, sourcePath: string): Promise<Buffer[]> {
    const [editorPath, applyPath] = await Promise.all([videoPath(editorId), videoPath(applyId)]);
    const frames: Buffer[] = [];
    for (const seconds of [0.5, 2, 3.6]) {
      const [base, editor, applied] = await Promise.all([frameAt(sourcePath, seconds, SMALL), frameAt(editorPath, seconds, SMALL), frameAt(applyPath, seconds, SMALL)]);
      expect(meanDifference(editor, applied), `${seconds}s`).toBeLessThan(0.25);
      frames.push(base, editor);
    }
    return frames;
  }

  it.each(["tiktok", "x"])("renders the %s watermark in place exactly as apply_watermark burns it", async (platform) => {
    const { sourcePath, editorId, applyId } = await twins();
    await renderInPlace(editorId, platform);
    const applied = await call<{ status: string; include_qr: boolean; template_id: string | null }>("apply_watermark", { asset_id: applyId, platform });
    expect(applied).toMatchObject({ status: "completed", include_qr: false, template_id: null });
    const [base, editor] = await expectTwinFrames(editorId, applyId, sourcePath);
    expect(meanDifference(base, editor)).toBeGreaterThan(0.05);
    const after = await call<Read>("video_graphics", { asset_id: editorId, watermark: true, platform });
    expect(after.burned).toMatchObject({ output: "replace" });
    expect(engine.settings.get(`graphics.draft.${editorId}`)).toBeNull();
  }, testBudget(300_000));

  it("saves the editor's watermark as the default that apply_watermark then burns", async () => {
    const { sourcePath, editorId, applyId } = await twins();
    const read = await call<Read>("video_graphics", { asset_id: editorId, watermark: true });
    const branded = await call<{ revision: string }>("video_graphics", {
      asset_id: editorId,
      watermark: true,
      op: "update",
      expected_revision: read.revision,
      document: appendGraphicsLayers(read.document, [BRAND]),
    });
    const saved = await call<{ template: { id: string; name: string } }>("video_graphics", { asset_id: editorId, op: "save_watermark", expected_revision: branded.revision });
    expect(saved.template.name).toBe("TikTok watermark");
    await renderInPlace(editorId, "tiktok", branded.revision);
    const applied = await call<{ status: string; template_id: string | null }>("apply_watermark", { asset_id: applyId, platform: "tiktok" });
    expect(applied).toMatchObject({ status: "completed", template_id: saved.template.id });
    const frames = await expectTwinFrames(editorId, applyId, sourcePath);
    expect(colorCount(frames[1], MAGENTA, 90)).toBeGreaterThan(300);
    expect(colorCount(frames[0], MAGENTA, 90)).toBe(0);
  }, testBudget(300_000));
});

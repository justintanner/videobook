import { createEngineForTest } from "../fs.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import { findAudioFile, type Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);
const BOOK_ID = "audio-mix-tool-test";

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: { content?: unknown }): Record<string, unknown> {
  return JSON.parse(((result.content ?? []) as TextContent)[0].text) as Record<string, unknown>;
}

describe("audio_mix tool", () => {
  let client: Client;
  let fs: Engine;
  let tempDir: string;
  let targetAssetId: string;
  let layerAssetId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-audio-mix-tool-"));
    const targetFixture = join(tempDir, "target.wav");
    const layerFixture = join(tempDir, "layer.wav");
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      "-c:a", "pcm_s16le",
      targetFixture,
    ]);
    await execFileAsync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=0.8:sample_rate=48000",
      "-c:a", "pcm_s16le",
      layerFixture,
    ]);

    fs = createEngineForTest(tempDir);
    const target = await fs.artifacts.create("aud", "target");
    const layer = await fs.artifacts.create("aud", "layer");
    if (!target.ok) throw new Error(target.error.message);
    if (!layer.ok) throw new Error(layer.error.message);
    targetAssetId = target.value.artifactId;
    layerAssetId = layer.value.artifactId;
    const targetWrite = await fs.files.write(targetAssetId, "original.wav", await readFile(targetFixture)
    );
    const layerWrite = await fs.files.write(layerAssetId, "original.wav", await readFile(layerFixture)
    );
    if (!targetWrite.ok) throw new Error(targetWrite.error.message);
    if (!layerWrite.ok) throw new Error(layerWrite.error.message);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: BOOK_ID },
    });
  });

  afterEach(async () => {
    await client.close();
    await queue.stop();
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("mixes the layer into the target and replaces the target in-place", async () => {
    const result = await client.callTool({
      name: "audio_mix",
      arguments: {
        target_asset_id: targetAssetId,
        layer_asset_id: layerAssetId,
        volume: 30,
        book_id: BOOK_ID,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toMatchObject({
      target_asset_id: targetAssetId,
      layer_asset_id: layerAssetId,
      volume: 30,
      status: "completed",
    });
    const manifest = await fs.files.manifest(targetAssetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const targetFile = findAudioFile(manifest.value.files, "audio");
    expect(targetFile?.name).toBe("original.wav");
    expect(manifest.value.files.some((file) => file.name.includes("audio_mix_pending"))).toBe(false);
    expect(manifest.value.files.some((file) => file.name.includes("audio_mix_backup"))).toBe(false);
    const probe = await probeVideo(join(manifest.value.path, "original.wav"));
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioDuration).toBeCloseTo(2, 1);
    const waveform = await fs.metadata.waveforms.read(targetAssetId);
    expect(waveform.ok).toBe(true);
  }, 30_000);

  it("rejects volume above 100 before enqueueing", async () => {
    const result = await client.callTool({
      name: "audio_mix",
      arguments: {
        target_asset_id: targetAssetId,
        layer_asset_id: layerAssetId,
        volume: 101,
        book_id: BOOK_ID,
      },
    });
    expect(result.isError).toBe(true);
  });
});

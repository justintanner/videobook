import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, getProjectsDir } from "../queue.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const PROJECT = "e2e-process-video-waveform";

type TextContent = Array<{ type: string; text: string }>;

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
}

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function pollForFile(filePath: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fileExists(filePath)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${filePath} not found after ${timeoutMs}ms`);
}

describe("process_video persists audio waveform via vc-engine primitive", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;
  let assetDir: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-pv-wave-"));
    const videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);

    const createResult = await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();

    const data = (await readFile(videoPath)).toString("base64");
    const uploaded = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: PROJECT, filename: "original.mp4", data },
    });
    const parsed = parse(uploaded) as unknown as { assetId: string };
    assetId = parsed.assetId;
    assetDir = join(tempDir, PROJECT, assetId);

    await pollForFile(join(assetDir, ".original.json"), 60_000);
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("writes audio_waveforms row + per-asset export and emits no waveform.json sidecar", async () => {
    const fs = createFsForTest(getProjectsDir());

    const wave = await fs.readAudioWaveform(assetId, PROJECT);
    expect(wave.ok).toBe(true);
    if (!wave.ok) return;
    expect(wave.value.bar_count).toBeGreaterThan(0);
    expect(Array.isArray(wave.value.peaks)).toBe(true);
    expect(wave.value.peaks.length).toBe(wave.value.bar_count);

    const manifest = await fs.getManifest(assetId, PROJECT, { includeDotfiles: true });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.files.find((f) => f.name === "waveform.json")).toBeUndefined();

    const exportPath = join(
      tempDir,
      PROJECT,
      ".videocity",
      "export",
      "audio_waveforms",
      `${assetId}.json`,
    );
    expect(await fileExists(exportPath)).toBe(true);
  });
});

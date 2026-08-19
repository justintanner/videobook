import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue, getEngineRoot } from "../queue.js";
import { createEngineForTest } from "../engine.js";
import type { Client } from "@modelcontextprotocol/client";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const PROJECT = "e2e-process-video-waveform";

type TextContent = Array<{ type: string; text: string }>;

function parse(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
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

describe("process_video persists audio waveform via videobook-engine primitive", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;

  beforeAll(async () => {
    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-e2e-pv-wave-"));
    const videoPath = join(tempDir, "test-source.mp4");
    await generateTestVideo(videoPath);
    client = await createTestClient(tempDir);

    const createResult = await client.callTool({
      name: "create_project",
      arguments: { book_id: PROJECT },
    });
    expect(createResult.isError).toBeFalsy();

    const data = (await readFile(videoPath)).toString("base64");
    const uploaded = await client.callTool({
      name: "upload_file",
      arguments: { book_id: PROJECT, filename: "original.mp4", data },
    });
    const parsed = parse(uploaded) as unknown as { assetId: string };
    assetId = parsed.assetId;
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("writes audio_waveforms in Dolt and emits no waveform sidecar", async () => {
    const fs = createEngineForTest(getEngineRoot());

    const wave = await fs.metadata.waveforms.read(assetId);
    expect(wave.ok).toBe(true);
    if (!wave.ok) return;
    expect(Array.isArray(wave.value.peaks)).toBe(true);
    expect(wave.value.peaks.length).toBeGreaterThan(0);

    const manifest = await fs.files.manifest(assetId);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.files.find((f) => f.name === "waveform.json")).toBeUndefined();
  });
});

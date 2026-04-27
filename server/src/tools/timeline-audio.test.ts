import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestAudio(outputPath: string, durationSec: number): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
    "-c:a", "libmp3lame", "-b:a", "128k",
    outputPath,
  ]);
}

async function uploadAudio(
  client: Client,
  projectSlug: string,
  audioPath: string,
): Promise<{ assetId: string }> {
  const data = (await readFile(audioPath)).toString("base64");
  const result = await client.callTool({
    name: "upload_file",
    arguments: { project_slug: projectSlug, filename: "original.mp3", data },
  });
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("timeline audio tools", () => {
  let client: Client;
  let tempDir: string;
  let audioPath: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-timeline-audio-test-"));
    audioPath = join(tempDir, "tone.mp3");
    await generateTestAudio(audioPath, 2);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "audio-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("add_timeline_audio appends a clip with auto-probed duration", async () => {
    const { assetId } = await uploadAudio(client, "audio-proj", audioPath);

    const result = await client.callTool({
      name: "add_timeline_audio",
      arguments: {
        project_slug: "audio-proj",
        asset_id: assetId,
        start_frame: 60,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.clip.id).toMatch(/.+/);
    expect(parsed.clip.slug).toBe(assetId);
    expect(parsed.clip.startFrame).toBe(60);
    // ~2 seconds at 30 fps → ~60 frames (allow rounding tolerance)
    expect(parsed.clip.durationFrames).toBeGreaterThanOrEqual(58);
    expect(parsed.clip.durationFrames).toBeLessThanOrEqual(62);
    expect(parsed.audio).toHaveLength(1);
  });

  it("rejects non-aud assets", async () => {
    const result = await client.callTool({
      name: "add_timeline_audio",
      arguments: {
        project_slug: "audio-proj",
        asset_id: "vid-not-an-audio-asset",
        start_frame: 0,
      },
    });
    expect(result.isError).toBe(true);
  });

  it("move_timeline_audio updates startFrame", async () => {
    const { assetId } = await uploadAudio(client, "audio-proj", audioPath);
    const addResult = await client.callTool({
      name: "add_timeline_audio",
      arguments: { project_slug: "audio-proj", asset_id: assetId, start_frame: 0 },
    });
    const added = JSON.parse((addResult.content as TextContent)[0].text);

    const moveResult = await client.callTool({
      name: "move_timeline_audio",
      arguments: {
        project_slug: "audio-proj",
        audio_id: added.clip.id,
        start_frame: 120,
      },
    });
    expect(moveResult.isError).toBeFalsy();
    const moved = JSON.parse((moveResult.content as TextContent)[0].text);
    expect(moved.clip.startFrame).toBe(120);
    expect(moved.audio).toHaveLength(1);
  });

  it("remove_timeline_audio drops the clip by id", async () => {
    const { assetId } = await uploadAudio(client, "audio-proj", audioPath);
    const addResult = await client.callTool({
      name: "add_timeline_audio",
      arguments: { project_slug: "audio-proj", asset_id: assetId, start_frame: 0 },
    });
    const added = JSON.parse((addResult.content as TextContent)[0].text);

    const removeResult = await client.callTool({
      name: "remove_timeline_audio",
      arguments: {
        project_slug: "audio-proj",
        audio_id: added.clip.id,
      },
    });
    expect(removeResult.isError).toBeFalsy();
    const after = JSON.parse((removeResult.content as TextContent)[0].text);
    expect(after.audio).toHaveLength(0);
  });

  it("update_timeline_audio persists volume and fades", async () => {
    const { assetId } = await uploadAudio(client, "audio-proj", audioPath);
    const addResult = await client.callTool({
      name: "add_timeline_audio",
      arguments: { project_slug: "audio-proj", asset_id: assetId, start_frame: 0 },
    });
    const added = JSON.parse((addResult.content as TextContent)[0].text);

    const updateResult = await client.callTool({
      name: "update_timeline_audio",
      arguments: {
        project_slug: "audio-proj",
        audio_id: added.clip.id,
        volume: 50,
        fade_in: 500,
        fade_out: 250,
      },
    });
    expect(updateResult.isError).toBeFalsy();
    const updated = JSON.parse((updateResult.content as TextContent)[0].text);
    expect(updated.clip.volume).toBe(50);
    expect(updated.clip.fadeIn).toBe(500);
    expect(updated.clip.fadeOut).toBe(250);

    // Confirm round-trip via get_timeline
    const getResult = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "audio-proj" },
    });
    const config = JSON.parse((getResult.content as TextContent)[0].text);
    expect(config.audio[0].volume).toBe(50);
    expect(config.audio[0].fadeIn).toBe(500);
    expect(config.audio[0].fadeOut).toBe(250);
  });

  it("update_timeline_audio rejects when nothing to update", async () => {
    const { assetId } = await uploadAudio(client, "audio-proj", audioPath);
    const addResult = await client.callTool({
      name: "add_timeline_audio",
      arguments: { project_slug: "audio-proj", asset_id: assetId, start_frame: 0 },
    });
    const added = JSON.parse((addResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "update_timeline_audio",
      arguments: { project_slug: "audio-proj", audio_id: added.clip.id },
    });
    expect(result.isError).toBe(true);
  });

  it("get_timeline returns the audio array after additions", async () => {
    const { assetId } = await uploadAudio(client, "audio-proj", audioPath);
    await client.callTool({
      name: "add_timeline_audio",
      arguments: { project_slug: "audio-proj", asset_id: assetId, start_frame: 30 },
    });

    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "audio-proj" },
    });
    expect(result.isError).toBeFalsy();
    const config = JSON.parse((result.content as TextContent)[0].text);
    expect(config.audio).toBeDefined();
    expect(config.audio).toHaveLength(1);
    expect(config.audio[0].slug).toBe(assetId);
    expect(config.audio[0].startFrame).toBe(30);
  });
});

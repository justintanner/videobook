import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import type { ArtifactKind, Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../fs.js";
import { registerJobHandler } from "../queue.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const BOOK_ID = "replicate-song-book";
const VALID_KEY = "fake-elevenlabs-key";

type TextContent = Array<{ type: string; text: string }>;

describe("replicate_song tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;
  let fixtureIndex: number;
  let originalElevenLabsApiKey: string | undefined;

  async function createArtifact(kind: ArtifactKind, label: string): Promise<string> {
    const created = await fs.artifacts.create({ kind, label });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.artifactId;
  }

  async function renderFixture(filename: string, args: string[]): Promise<Buffer> {
    const outputPath = join(
      tempDir,
      `fixture-${fixtureIndex++}${extname(filename) || ".mp4"}`,
    );
    await execFileAsync(FFMPEG, ["-y", ...args, outputPath]);
    return readFile(outputPath);
  }

  async function createVideoWithAudio(
    durationSeconds: number,
    options: {
      filename?: string;
      audioDurationSeconds?: number;
      frameRate?: number;
      label?: string;
    } = {},
  ): Promise<string> {
    const filename = options.filename ?? "original.mp4";
    const audioDuration = options.audioDurationSeconds ?? durationSeconds;
    const frameRate = options.frameRate ?? 1;
    const bytes = await renderFixture(filename, [
      "-f", "lavfi",
      "-i", `color=c=black:s=16x16:r=${frameRate}:d=${durationSeconds}`,
      "-f", "lavfi",
      "-i", `sine=frequency=440:sample_rate=48000:duration=${audioDuration}`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
    ]);
    const assetId = await createArtifact("video", options.label ?? `source-${durationSeconds}`);
    const written = await fs.files.write(assetId, filename, bytes);
    if (!written.ok) throw new Error(written.error.message);
    return assetId;
  }

  async function callReplicate(
    assetId: string,
    direction?: string,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    return client.callTool({
      name: "replicate_song",
      arguments: {
        asset_id: assetId,
        book_id: BOOK_ID,
        ...(direction !== undefined ? { direction } : {}),
      },
    });
  }

  beforeEach(async () => {
    originalElevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-replicate-song-tool-"));
    fixtureIndex = 0;
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: BOOK_ID },
    });
    registerJobHandler("generate_replicated_song", async (payload) => payload);
  });

  afterEach(async () => {
    if (originalElevenLabsApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalElevenLabsApiKey;
    await client.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("requires a configured non-placeholder ElevenLabs key", async () => {
    const result = await callReplicate("missing-video");

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("ELEVENLABS_API_KEY");
    expect(fs.artifacts.list()).toHaveLength(0);
  });

  it("rejects artifacts that are not video before creating output", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const assetId = await createArtifact("audio", "not-video");
    const before = fs.artifacts.list().length;

    const result = await callReplicate(`@${assetId}`);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("requires video media");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects a video artifact without a supported video file", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const assetId = await createArtifact("video", "missing-file");
    const written = await fs.files.write(assetId, "notes.txt", "no media");
    if (!written.ok) throw new Error(written.error.message);
    const before = fs.artifacts.list().length;

    const result = await callReplicate(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("No video file");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects a canonical media file without a video stream", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const bytes = await renderFixture("original.mp4", [
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=12",
      "-vn",
      "-c:a", "aac",
    ]);
    const assetId = await createArtifact("video", "audio-only");
    const written = await fs.files.write(assetId, "original.mp4", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const before = fs.artifacts.list().length;

    const result = await callReplicate(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("no video stream");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects a video without an audio stream", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const bytes = await renderFixture("original.mp4", [
      "-f", "lavfi",
      "-i", "color=c=black:s=16x16:r=1:d=12",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-an",
    ]);
    const assetId = await createArtifact("video", "silent-video");
    const written = await fs.files.write(assetId, "original.mp4", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const before = fs.artifacts.list().length;

    const result = await callReplicate(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("no audio stream");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects rounded video-stream durations outside the inclusive bounds", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const shortId = await createVideoWithAudio(9.999, { frameRate: 1_000 });
    const longId = await createVideoWithAudio(30.001, { frameRate: 1_000 });
    const before = fs.artifacts.list().length;

    const shortResult = await callReplicate(shortId);
    const longResult = await callReplicate(longId);

    expect(shortResult.isError).toBe(true);
    expect(longResult.isError).toBe(true);
    expect((shortResult.content as TextContent)[0].text).toContain("10.000s and 30.000s inclusive");
    expect((longResult.content as TextContent)[0].text).toContain("10.000s and 30.000s inclusive");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("accepts video-stream durations at both inclusive bounds", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const minimumId = await createVideoWithAudio(10);
    const maximumId = await createVideoWithAudio(30);

    const minimumResult = await callReplicate(minimumId);
    const maximumResult = await callReplicate(maximumId);

    expect(minimumResult.isError).toBeFalsy();
    expect(maximumResult.isError).toBeFalsy();
    expect(JSON.parse((minimumResult.content as TextContent)[0].text).duration_seconds).toBe(10);
    expect(JSON.parse((maximumResult.content as TextContent)[0].text).duration_seconds).toBe(30);
  });

  it("creates one output artifact and enqueues the normalized 22.010 second job", async () => {
    process.env.ELEVENLABS_API_KEY = VALID_KEY;
    const sourceId = await createVideoWithAudio(22.01, {
      filename: "source.mov",
      audioDurationSeconds: 24,
      frameRate: 100,
      label: "dance-reference",
    });
    const before = fs.artifacts.list().length;

    const result = await callReplicate(`@${sourceId}`, "  stronger low strings  ");

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed).toMatchObject({
      source_video: sourceId,
      duration_seconds: 22.01,
      status: "enqueued",
    });
    expect(typeof parsed.audio_asset_id).toBe("string");
    expect(typeof parsed.job_id).toBe("string");
    const artifacts = fs.artifacts.list();
    expect(artifacts).toHaveLength(before + 1);
    expect(artifacts.filter((artifact) => artifact.kind === "audio")).toHaveLength(1);
    const output = fs.artifacts.get(parsed.audio_asset_id);
    expect(output.ok && output.value.label).toBe("replicated-song-dance-reference");

    const jobs = fs.jobs.queue.list({
      states: ["queued", "running", "completing", "done", "failed", "aborted"],
    });
    const job = jobs.find((entry) => entry.type === "generate_replicated_song");
    expect(job?.payload).toEqual({
      type: "generate_replicated_song",
      audAssetId: parsed.audio_asset_id,
      sourceAssetId: sourceId,
      sourceFilename: "source.mov",
      targetDurationMs: 22_010,
      direction: "stronger low strings",
      bookId: fs.book.get().bookId,
    });
  });
});

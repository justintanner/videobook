import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import type { ArtifactKind, Engine } from "videobook-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { registerJobHandler } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { routedMediaCellInputs } from "../../../src/videobook/notebook-routed-action.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const BOOK_ID = "make-cover-song-book";
const REQUIRED_MODEL_FILES = [
  "acestep-v15-turbo-Q4_K_M.gguf",
  "Qwen3-Embedding-0.6B-Q8_0.gguf",
  "vae-BF16.gguf",
];
const ACESTEP_ENV_VARS = [
  "VIDEOBOOK_ACESTEP_BASE_URL",
  "VIDEOBOOK_ACESTEP_SERVER_PATH",
  "VIDEOBOOK_ACESTEP_MODELS_DIR",
];

type TextContent = Array<{ type: string; text: string }>;

describe("make_cover_song tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;
  let fixtureIndex: number;
  let savedEnv: Record<string, string | undefined>;

  async function createArtifact(kind: ArtifactKind, label: string): Promise<string> {
    const created = await fs.artifacts.create({ kind, label });
    if (!created.ok) throw new Error(created.error.message);
    return created.value.artifactId;
  }

  // The availability gate is pure filesystem checks, so a fake binary and fake
  // model files make the tool "installed" without any HTTP or real runtime.
  async function installFakeAcestep(): Promise<void> {
    const runtimeDir = join(tempDir, "fake-acestep");
    const modelsDir = join(runtimeDir, "models");
    await mkdir(modelsDir, { recursive: true });
    const serverPath = join(runtimeDir, "ace-server");
    await writeFile(serverPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const name of REQUIRED_MODEL_FILES) {
      await writeFile(join(modelsDir, name), "fake-gguf");
    }
    process.env.VIDEOBOOK_ACESTEP_SERVER_PATH = serverPath;
    process.env.VIDEOBOOK_ACESTEP_MODELS_DIR = modelsDir;
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

  async function createAudio(
    durationSeconds: number,
    options: { filename?: string; label?: string } = {},
  ): Promise<string> {
    const filename = options.filename ?? "original.wav";
    const bytes = await renderFixture(filename, [
      "-f", "lavfi",
      "-i", `sine=frequency=440:sample_rate=48000:duration=${durationSeconds}`,
      "-vn",
      "-c:a", "pcm_s16le",
    ]);
    const assetId = await createArtifact("audio", options.label ?? `source-audio-${durationSeconds}`);
    const written = await fs.files.write(assetId, filename, bytes);
    if (!written.ok) throw new Error(written.error.message);
    return assetId;
  }

  async function callMakeCoverSong(
    assetId: string,
    direction?: string,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    return client.callTool({
      name: "make_cover_song",
      arguments: {
        asset_id: assetId,
        book_id: BOOK_ID,
        ...(direction !== undefined ? { direction } : {}),
      },
    });
  }

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ACESTEP_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of ACESTEP_ENV_VARS) delete process.env[name];
    tempDir = await mkdtemp(join(tmpdir(), "videocity-make-cover-song-tool-"));
    fixtureIndex = 0;
    fs = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: BOOK_ID },
    });
    await installFakeAcestep();
    registerJobHandler("generate_acestep_cover", async (payload) => payload);
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await client.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("is exposed under the make_cover_song MCP name", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("make_cover_song");
    expect(names).not.toContain("replicate_song");
  });

  it("requires an installed acestep.cpp runtime", async () => {
    process.env.VIDEOBOOK_ACESTEP_SERVER_PATH = "/nonexistent/ace-server";

    const result = await callMakeCoverSong("missing-media");

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("ace-server not found at /nonexistent/ace-server");
    expect((result.content as TextContent)[0].text).toContain("install:acestep");
    expect(fs.artifacts.list()).toHaveLength(0);
  });

  it("reports missing model files by name", async () => {
    process.env.VIDEOBOOK_ACESTEP_MODELS_DIR = "/nonexistent/acestep-models";

    const result = await callMakeCoverSong("missing-media");

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("ACE-Step models missing");
    expect((result.content as TextContent)[0].text).toContain("acestep-v15-turbo-Q4_K_M.gguf");
    expect(fs.artifacts.list()).toHaveLength(0);
  });

  it("rejects artifacts that are neither video nor audio before creating output", async () => {
    const assetId = await createArtifact("image", "not-media");
    const before = fs.artifacts.list().length;

    const result = await callMakeCoverSong(`@${assetId}`);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("requires video or audio media");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects a video artifact without a supported video file", async () => {
    const assetId = await createArtifact("video", "missing-file");
    const written = await fs.files.write(assetId, "notes.txt", "no media");
    if (!written.ok) throw new Error(written.error.message);
    const before = fs.artifacts.list().length;

    const result = await callMakeCoverSong(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("No video file");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects an audio artifact without a supported audio file", async () => {
    const assetId = await createArtifact("audio", "missing-file");
    const written = await fs.files.write(assetId, "notes.txt", "no media");
    if (!written.ok) throw new Error(written.error.message);
    const before = fs.artifacts.list().length;

    const result = await callMakeCoverSong(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("No audio file");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects a canonical media file without a video stream", async () => {
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

    const result = await callMakeCoverSong(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("no video stream");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects a video without an audio stream", async () => {
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

    const result = await callMakeCoverSong(assetId);

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("no audio stream");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("rejects rounded durations outside the inclusive bounds", async () => {
    const shortId = await createVideoWithAudio(9.999, { frameRate: 1_000 });
    const longId = await createAudio(240.001, { label: "too-long" });
    const before = fs.artifacts.list().length;

    const shortResult = await callMakeCoverSong(shortId);
    const longResult = await callMakeCoverSong(longId);

    expect(shortResult.isError).toBe(true);
    expect(longResult.isError).toBe(true);
    expect((shortResult.content as TextContent)[0].text).toContain("10.000s and 240.000s inclusive");
    expect((longResult.content as TextContent)[0].text).toContain("10.000s and 240.000s inclusive");
    expect(fs.artifacts.list()).toHaveLength(before);
  });

  it("accepts durations at both inclusive bounds", async () => {
    const minimumId = await createVideoWithAudio(10);
    const maximumId = await createAudio(240, { label: "max-length" });

    const minimumResult = await callMakeCoverSong(minimumId);
    const maximumResult = await callMakeCoverSong(maximumId);

    expect(minimumResult.isError).toBeFalsy();
    expect(maximumResult.isError).toBeFalsy();
    expect(JSON.parse((minimumResult.content as TextContent)[0].text).duration_seconds).toBe(10);
    expect(JSON.parse((maximumResult.content as TextContent)[0].text).duration_seconds).toBe(240);
  });

  it("accepts an audio artifact and uses its audio-stream duration", async () => {
    const sourceId = await createAudio(18.25, { label: "audio-reference" });
    const before = fs.artifacts.list().length;

    const result = await callMakeCoverSong(`@${sourceId}`);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed).toMatchObject({
      source_asset_id: sourceId,
      source_kind: "audio",
      duration_seconds: 18.25,
      status: "enqueued",
    });
    expect(fs.artifacts.list()).toHaveLength(before + 1);
    const output = fs.artifacts.get(parsed.audio_asset_id);
    expect(output.ok && output.value.label).toBe("cover-song-audio-reference");

    const jobs = fs.jobs.queue.list({
      states: ["queued", "running", "completing", "done", "failed", "aborted"],
    });
    const job = jobs.find((entry) => entry.type === "generate_acestep_cover");
    expect(job?.payload).toMatchObject({
      sourceAssetId: sourceId,
      sourceFilename: "original.wav",
      targetDurationMs: 18_250,
    });
  });

  it("places the enqueued cover artifact in an audio notebook cell", async () => {
    const sourceId = await createAudio(18.25, { label: "grid-reference" });
    const notebookResult = await client.callTool({
      name: "create_notebook",
      arguments: { book_id: BOOK_ID, name: "Main" },
    });
    const notebookId = JSON.parse((notebookResult.content as TextContent)[0].text).id as string;
    await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: BOOK_ID,
        notebook_id: notebookId,
        cell: {
          type: "audio",
          label: "Source audio",
          slot: { row: 0, column: 0 },
          output_artifact_id: sourceId,
        },
      },
    });

    const result = await callMakeCoverSong(`@${sourceId}`);
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    const current = fs.notebooks.read(notebookId);
    if (!current.ok) throw new Error(current.error.message);
    const placements = routedMediaCellInputs(
      "make_cover_song",
      parsed,
      current.value.cells,
    );

    expect(placements).toHaveLength(1);
    await client.callTool({
      name: "create_notebook_cell",
      arguments: {
        book_id: BOOK_ID,
        notebook_id: notebookId,
        cell: placements[0],
      },
    });
    const updated = fs.notebooks.read(notebookId);
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.value.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "audio",
        slot: { row: 0, column: 1 },
        outputArtifactId: parsed.audio_asset_id,
        inputs: expect.objectContaining({
          sourceOperation: "make_cover_song",
          source_asset_id: sourceId,
          job_id: parsed.job_id,
        }),
      }),
    ]));
  });

  it("creates one output artifact and enqueues the normalized 22.010 second job", async () => {
    const sourceId = await createVideoWithAudio(22.01, {
      filename: "source.mov",
      audioDurationSeconds: 24,
      frameRate: 100,
      label: "dance-reference",
    });
    const before = fs.artifacts.list().length;

    const result = await callMakeCoverSong(`@${sourceId}`, "  stronger low strings  ");

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed).toMatchObject({
      source_asset_id: sourceId,
      source_kind: "video",
      duration_seconds: 22.01,
      status: "enqueued",
    });
    expect(typeof parsed.audio_asset_id).toBe("string");
    expect(typeof parsed.job_id).toBe("string");
    const artifacts = fs.artifacts.list();
    expect(artifacts).toHaveLength(before + 1);
    expect(artifacts.filter((artifact) => artifact.kind === "audio")).toHaveLength(1);
    const output = fs.artifacts.get(parsed.audio_asset_id);
    expect(output.ok && output.value.label).toBe("cover-song-dance-reference");

    const jobs = fs.jobs.queue.list({
      states: ["queued", "running", "completing", "done", "failed", "aborted"],
    });
    const job = jobs.find((entry) => entry.type === "generate_acestep_cover");
    expect(job?.payload).toEqual({
      type: "generate_acestep_cover",
      audAssetId: parsed.audio_asset_id,
      sourceAssetId: sourceId,
      sourceFilename: "source.mov",
      targetDurationMs: 22_010,
      direction: "stronger low strings",
      bookId: fs.book.get().bookId,
    });
  });
});

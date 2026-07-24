import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
import { queue } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import { resolveHasAudioForCuts } from "./apply-cuts.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

type TextContent = Array<{ type: string; text: string }>;

async function generateTestVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    outputPath,
  ]);
}

async function generateSilentVideo(outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-an",
    outputPath,
  ]);
}

// Drop the video into the asset dir directly via the fs API instead of
// upload_file — that path enqueues process_video, which kicks off ffmpeg in
// the background. If the next test's beforeEach fires before that work
// finishes, setEngineRoot has to drain the runner past the 30s hookTimeout
// on slower machines, producing a misleading "beforeEach hook timed out" on
// whichever test happens to be next.
async function placeVideo(
  projectsDir: string,
  projectSlug: string,
  videoPath: string,
): Promise<{ assetId: string; path: string }> {
  const fs = createEngineForTest(projectsDir);
  const asset = await fs.artifacts.create("vid", "test-source", projectSlug);
  if (!asset.ok) throw new Error(`createAsset failed: ${asset.error.message}`);
  const bytes = await readFile(videoPath);
  const written = await fs.files.write(
    asset.value.slug,
    "original.mp4",
    bytes,
    projectSlug,
  );
  if (!written.ok) throw new Error(`writeFile failed: ${written.error.message}`);
  return { assetId: asset.value.slug, path: asset.value.path };
}

describe("apply_cuts tool", () => {
  let client: Client;
  let tempDir: string;
  let fixtureDir: string;
  let videoPath: string;

  beforeAll(async () => {
    await queue.start();
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-apply-cuts-fixture-"));
    videoPath = join(fixtureDir, "test-source.mp4");
    await generateTestVideo(videoPath);
  }, 60_000);

  afterAll(async () => {
    await queue.stop();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-apply-cuts-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "cuts-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("splices a single middle cut", async () => {
    const uploaded = await placeVideo(tempDir, "cuts-proj", videoPath);

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "cuts-proj",
        cuts: [{ cut_start: 1, cut_end: 2 }],
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.asset_id).toBe(uploaded.assetId);

    const probe = await probeVideo(join(uploaded.path, "original.mp4"));
    expect(probe.duration).toBeGreaterThan(1.7);
    expect(probe.duration).toBeLessThan(2.3);
  }, 60_000);

  it("splices two non-overlapping cuts", async () => {
    const uploaded = await placeVideo(tempDir, "cuts-proj", videoPath);

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "cuts-proj",
        cuts: [
          { cut_start: 0.5, cut_end: 1.0 },
          { cut_start: 2.0, cut_end: 2.5 },
        ],
      },
    });

    expect(result.isError).toBeFalsy();

    const probe = await probeVideo(join(uploaded.path, "original.mp4"));
    expect(probe.duration).toBeGreaterThan(1.7);
    expect(probe.duration).toBeLessThan(2.3);
  }, 60_000);

  it("returns error for overlapping cuts", async () => {
    const uploaded = await placeVideo(tempDir, "cuts-proj", videoPath);

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "cuts-proj",
        cuts: [
          { cut_start: 0.5, cut_end: 1.5 },
          { cut_start: 1.0, cut_end: 2.0 },
        ],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("overlap");
  });

  it("returns error for cut_end past duration", async () => {
    const uploaded = await placeVideo(tempDir, "cuts-proj", videoPath);
    const fs = createEngineForTest(tempDir);
    await fs.metadata.artifacts.write(
      uploaded.assetId,
      "original",
      { width: 320, height: 240, duration: 3, hasAudio: true },
      "cuts-proj",
    );

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "cuts-proj",
        cuts: [{ cut_start: 1, cut_end: 99 }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("exceeds video duration");
  });

  it("returns error for cut_start >= cut_end", async () => {
    const uploaded = await placeVideo(tempDir, "cuts-proj", videoPath);

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "cuts-proj",
        cuts: [{ cut_start: 2, cut_end: 1 }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("cut_start must be < cut_end");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "cuts-proj",
        cuts: [{ cut_start: 1, cut_end: 2 }],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("returns error when asset has no video", async () => {
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("vid", "no-video", "cuts-proj");
    if (!asset.ok) throw new Error("Failed to create asset");
    await fs.files.write(asset.value.slug, "notes.txt", "hello", "cuts-proj");

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: asset.value.slug,
        project_slug: "cuts-proj",
        cuts: [{ cut_start: 1, cut_end: 2 }],
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No video file");
  });

  it("cuts a silent video when metadata omits hasAudio (probes file)", async () => {
    const silentPath = join(fixtureDir, "silent-source.mp4");
    await generateSilentVideo(silentPath);
    const uploaded = await placeVideo(tempDir, "cuts-proj", silentPath);

    // Metadata has duration but deliberately no hasAudio — old code assumed true and failed.
    const fs = createEngineForTest(tempDir);
    await fs.metadata.artifacts.write(
      uploaded.assetId,
      "original",
      { width: 320, height: 240, duration: 3 },
      "cuts-proj",
    );

    const result = await client.callTool({
      name: "apply_cuts",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "cuts-proj",
        cuts: [{ cut_start: 1, cut_end: 2 }],
      },
    });

    expect(result.isError).toBeFalsy();
    const probe = await probeVideo(join(uploaded.path, "original.mp4"));
    expect(probe.duration).toBeGreaterThan(1.7);
    expect(probe.duration).toBeLessThan(2.3);
    expect(probe.hasAudio).toBe(false);
  }, 60_000);
});

describe("resolveHasAudioForCuts", () => {
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-hasaudio-"));
  }, 30_000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns metadata boolean without probing when present", async () => {
    await expect(resolveHasAudioForCuts(false, "/nonexistent/path.mp4")).resolves.toBe(false);
    await expect(resolveHasAudioForCuts(true, "/nonexistent/path.mp4")).resolves.toBe(true);
  });

  it("probes the file when metadata hasAudio is missing", async () => {
    const silentPath = join(fixtureDir, "probe-silent.mp4");
    await generateSilentVideo(silentPath);
    await expect(resolveHasAudioForCuts(undefined, silentPath)).resolves.toBe(false);

    const withAudio = join(fixtureDir, "probe-audio.mp4");
    await generateTestVideo(withAudio);
    await expect(resolveHasAudioForCuts(undefined, withAudio)).resolves.toBe(true);
  }, 60_000);
});

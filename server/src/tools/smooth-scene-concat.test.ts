import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createFs, type VideocityFs } from "videocity-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG } from "../ffmpeg.js";
import { queue, waitForJob } from "../queue.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);
const PROJECT = "scene-concat-proj";

type TextContent = Array<{ type: string; text: string }>;

async function createVideo(path: string, color: string, withAudio: boolean): Promise<void> {
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=${color}:s=160x90:r=20:d=1`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=1");
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  await execFileAsync(FFMPEG, args);
}

async function createVideoAsset(
  fs: VideocityFs,
  name: string,
  sourcePath: string,
): Promise<string> {
  const created = await fs.createAsset("vid", name, PROJECT);
  if (!created.ok) throw created.error;
  const written = await fs.writeFile(
    created.value.assetId,
    "original.mp4",
    await readFile(sourcePath),
    PROJECT,
  );
  if (!written.ok) throw written.error;
  return created.value.assetId;
}

describe("smooth_scene_concat tool", () => {
  let client: Client;
  let fs: VideocityFs;
  let projectsDir: string;
  let fixtureDir: string;
  let firstAssetId: string;
  let secondAssetId: string;

  beforeAll(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "videocity-scene-concat-projects-"));
    fixtureDir = await mkdtemp(join(tmpdir(), "videocity-scene-concat-fixtures-"));
    const firstPath = join(fixtureDir, "first.mp4");
    const secondPath = join(fixtureDir, "second.mp4");
    await Promise.all([
      createVideo(firstPath, "blue", true),
      createVideo(secondPath, "red", false),
    ]);

    client = await createTestClient(projectsDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT },
    });
    fs = createFs({ projectsDir });
    firstAssetId = await createVideoAsset(fs, "first", firstPath);
    secondAssetId = await createVideoAsset(fs, "second", secondPath);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    fs?.close();
    await Promise.all([
      rm(projectsDir, { recursive: true, force: true, maxRetries: 3 }),
      rm(fixtureDir, { recursive: true, force: true, maxRetries: 3 }),
    ]);
  }, 30_000);

  it("validates inputs and enqueues a new processed video asset", async () => {
    const sameAsset = await client.callTool({
      name: "smooth_scene_concat",
      arguments: {
        first_asset_id: firstAssetId,
        second_asset_id: firstAssetId,
        project_slug: PROJECT,
      },
    });
    expect(sameAsset.isError).toBe(true);

    const tooLong = await client.callTool({
      name: "smooth_scene_concat",
      arguments: {
        first_asset_id: firstAssetId,
        second_asset_id: secondAssetId,
        transition_seconds: 1,
        project_slug: PROJECT,
      },
    });
    expect(tooLong.isError).toBe(true);

    const result = await client.callTool({
      name: "smooth_scene_concat",
      arguments: {
        first_asset_id: firstAssetId,
        second_asset_id: secondAssetId,
        transition_seconds: 0.2,
        project_slug: PROJECT,
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      asset_id: string;
      job_id: string;
      status: string;
      alignment_mode: string;
    };
    expect(parsed.asset_id).toMatch(/^vid-scene-concat-first-second/);
    expect(parsed.status).toBe("enqueued");
    expect(parsed.alignment_mode).toBe("fixed");

    await waitForJob(parsed.job_id, 60_000);
    const metadata = await fs.readMetadata(parsed.asset_id, "original", PROJECT);
    if (!metadata.ok) throw metadata.error;
    expect(metadata.value).toMatchObject({
      origin: "smooth_scene_concat",
      first_asset: firstAssetId,
      second_asset: secondAssetId,
      alignment_mode: "fixed",
      transition_seconds: 0.2,
    });
  }, 60_000);
});

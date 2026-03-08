import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { queue, waitForJob } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-fs";

type TextContent = Array<{ type: string; text: string }>;
type ManifestFile = { name: string; size_bytes: number };

const PROJECT_SLUG = "e2e-pipeline";

async function pollManifestForFile(
  client: Client,
  assetId: string,
  fileName: string,
  timeoutMs = 30_000,
): Promise<ManifestFile> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: assetId, project_slug: PROJECT_SLUG },
    });
    const data = JSON.parse((result.content as TextContent)[0].text);
    const file = data.files.find((f: ManifestFile) => f.name === fileName);
    if (file) return file;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${fileName} not found in ${assetId} after ${timeoutMs}ms`);
}

describe("image → video e2e pipeline", () => {
  let client: Client;
  let fs: ClipfirstFs;
  let tempDir: string;

  beforeAll(async () => {
    if (!process.env.KIE_API_KEY) {
      console.warn("KIE_API_KEY not set — skipping e2e pipeline test");
      return;
    }

    await queue.start();
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-e2e-pipeline-"));
    client = await createTestClient(tempDir);
    fs = createFsForTest(tempDir);

    await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT_SLUG },
    });
  });

  afterAll(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("generates image then video with dialog prompt", async () => {
    if (!process.env.KIE_API_KEY) return;

    // 1. Generate image
    const imgResult = await client.callTool({
      name: "generate_nano_banana_image",
      arguments: {
        prompt: "a person speaking enthusiastically to the camera in a studio",
        project_slug: PROJECT_SLUG,
        aspect_ratio: "16:9",
      },
    });
    expect(imgResult.isError).toBeFalsy();
    const imgParsed = JSON.parse((imgResult.content as TextContent)[0].text);
    const imgAssetId: string = imgParsed.img_asset_id;
    expect(imgAssetId).toMatch(/^img-/);
    expect(imgParsed.status).toBe("enqueued");

    // 2. Wait for queue job to submit KIE task, then sleep to poll until done
    await waitForJob(imgParsed.job_id);
    const imgSleep = await client.callTool({
      name: "sleep",
      arguments: {
        asset_id: imgAssetId,
        project_slug: PROJECT_SLUG,
        timeout_seconds: 300,
      },
    });
    expect(imgSleep.isError).toBeFalsy();
    const imgSleepData = JSON.parse((imgSleep.content as TextContent)[0].text);
    expect(imgSleepData.status).toBe("ready");

    // 3. Verify image files
    const imgManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: imgAssetId, project_slug: PROJECT_SLUG },
    });
    const imgManifestData = JSON.parse((imgManifest.content as TextContent)[0].text);
    const imgFile = imgManifestData.files.find(
      (f: { name: string }) => f.name === "original.png" || f.name === "original.jpg",
    );
    expect(imgFile).toBeDefined();
    expect(imgFile.size_bytes).toBeGreaterThan(0);

    const kieTaskFile = imgManifestData.files.find(
      (f: { name: string }) => f.name === ".kie-task.json",
    );
    expect(kieTaskFile).toBeUndefined();

    // 4. Generate video from image
    const vidResult = await client.callTool({
      name: "generate_grok_imagine_video",
      arguments: {
        asset_id: imgAssetId,
        project_slug: PROJECT_SLUG,
        prompt:
          "the person says: hey everyone, welcome to our channel, let me show you something amazing today",
        duration: "6",
      },
    });
    expect(vidResult.isError).toBeFalsy();
    const vidParsed = JSON.parse((vidResult.content as TextContent)[0].text);
    const vidAssetId: string = vidParsed.vid_asset_id;
    expect(vidAssetId).toMatch(/^vid-/);
    expect(vidParsed.status).toBe("enqueued");

    // 5. Wait for queue job to submit KIE task, then sleep to poll until done
    await waitForJob(vidParsed.job_id);
    const vidSleep = await client.callTool({
      name: "sleep",
      arguments: {
        asset_id: vidAssetId,
        project_slug: PROJECT_SLUG,
        timeout_seconds: 300,
      },
    });
    expect(vidSleep.isError).toBeFalsy();
    const vidSleepData = JSON.parse((vidSleep.content as TextContent)[0].text);
    expect(vidSleepData.status).toBe("ready");

    // 6. Verify video files (poll for .original.json since process_video runs after sleep returns)
    const mp4File = await pollManifestForFile(client, vidAssetId, "original.mp4");
    expect(mp4File.size_bytes).toBeGreaterThan(0);

    await pollManifestForFile(client, vidAssetId, ".original.json");

    const vidManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: vidAssetId, project_slug: PROJECT_SLUG },
    });
    const vidManifestData = JSON.parse((vidManifest.content as TextContent)[0].text);
    const vidKieTask = vidManifestData.files.find(
      (f: { name: string }) => f.name === ".kie-task.json",
    );
    expect(vidKieTask).toBeUndefined();

    // 7. Verify action logs
    const actionLog = await fs.getActionLog(undefined, PROJECT_SLUG);
    const actions = actionLog.map((e) => e.action);

    expect(actions).toContain("tool-generate-nano-banana-image");
    expect(actions).toContain("tool-sleep");
    expect(actions).toContain("tool-generate-grok-imagine-video");
    expect(actions).toContain("tool-asset-manifest");
  });
});

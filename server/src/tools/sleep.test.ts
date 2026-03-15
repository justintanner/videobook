import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { sleepDef } from "./sleep.js";
import { writePendingTask } from "../jobs/pending-task.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-fs";

describe("sleep tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns not_found for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "sleep",
      arguments: {
        asset_id: "vid-does-not-exist",
        project_slug: "test-proj",
        timeout_seconds: 1,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.status).toBe("not_found");
  });

  it("returns ready immediately for asset with no pending task and not locked", async () => {
    // Upload a file to create an asset
    const imgData = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data: imgData },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "sleep",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "test-proj",
        timeout_seconds: 1,
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.status).toBe("ready");
    expect(data.asset_id).toBe(uploaded.assetId);
  });
});

describe("sleepDef handler", () => {
  let fs: ClipfirstFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-sleep-test-"));
    fs = createFsForTest(tempDir);
    await fs.createProject("test-proj");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns timeout for asset with pending task that never completes", async () => {
    const assetResult = await fs.createAsset("vid", "pending-asset", "test-proj");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    // Write a pending task so sleep never resolves to ready
    await writePendingTask(fs, assetId, "test-proj", {
      taskId: "task-will-timeout",
      taskType: "transcribe",
      assetId,
      assetDir: assetResult.value.path,
      projectSlug: "test-proj",
      createdAt: new Date().toISOString(),
      meta: {},
    });

    // No KIE_API_KEY so task polling is skipped, pending task stays
    const savedKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;

    try {
      const def = sleepDef(fs);
      const result = await def.handler({
        asset_id: assetId,
        project_slug: "test-proj",
        timeout_seconds: 0,
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("timeout");
      expect(data.asset_id).toBe(assetId);
      expect(data.iterations).toBeGreaterThanOrEqual(0);
    } finally {
      if (savedKey !== undefined) {
        process.env.KIE_API_KEY = savedKey;
      }
    }
  }, 15_000);
});

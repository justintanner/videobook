import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { whitelistDef } from "./whitelist-asset.js";
import { writePendingTask } from "../jobs/pending-task.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClipfirstFs } from "clipfirst-fs";

function parseText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe("whitelist tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: ClipfirstFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    fs = createFsForTest(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("whitelist non-vid asset returns error", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "whitelist",
      arguments: { asset_id: "img-something", project_slug: "test" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("Only video assets");
  });

  it("whitelist nonexistent asset returns error", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test" },
    });
    const result = await client.callTool({
      name: "whitelist",
      arguments: { asset_id: "vid-nonexistent", project_slug: "test" },
    });
    expect(result.isError).toBe(true);
  });

  it("whitelist vid asset succeeds with status whitelisted", async () => {
    client = await createTestClient(tempDir);
    await fs.createProject("test");
    const assetResult = await fs.createAsset("vid", "cute-cat", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    const result = await client.callTool({
      name: "whitelist",
      arguments: { asset_id: assetId, project_slug: "test" },
    });
    expect(result.isError).toBeFalsy();
    const data = parseText(result);
    expect(data.status).toBe("whitelisted");
    expect(data.asset_id).toBe(assetId);
    expect(data.whitelisted_at).toBeDefined();
  });

  it("whitelist twice succeeds without error", async () => {
    client = await createTestClient(tempDir);
    await fs.createProject("test");
    const assetResult = await fs.createAsset("vid", "cute-cat", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    const first = await client.callTool({
      name: "whitelist",
      arguments: { asset_id: assetId, project_slug: "test" },
    });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({
      name: "whitelist",
      arguments: { asset_id: assetId, project_slug: "test" },
    });
    expect(second.isError).toBeFalsy();
    const data = parseText(second);
    expect(data.asset_id).toBe(assetId);
    expect(data.whitelisted_at).toBeDefined();
  });
});

describe("whitelist pipeline branches", () => {
  let fs: ClipfirstFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-whitelist-test-"));
    fs = createFsForTest(tempDir);
    await fs.createProject("test");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns skipped_in_progress when asset has .kie-task.json", async () => {
    const assetResult = await fs.createAsset("vid", "in-progress", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    await writePendingTask(fs, assetId, "test", {
      taskId: "task-123",
      taskType: "transcribe",
      assetId,
      assetDir: assetResult.value.path,
      projectSlug: "test",
      createdAt: new Date().toISOString(),
      meta: {},
    });

    const def = whitelistDef(fs);
    const result = await def.handler({ asset_id: assetId, project_slug: "test" });
    const data = JSON.parse(result.content[0].text);
    expect(data.transcription).toBe("skipped_in_progress");
  });

  it("returns skipped_prior_failure when asset has .generation-error.json", async () => {
    const assetResult = await fs.createAsset("vid", "prior-failure", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    await fs.writeFile(assetId, ".original.analysis.json", JSON.stringify({ duration: 10 }), "test");
    await fs.writeFile(
      assetId,
      ".generation-error.json",
      JSON.stringify({
        message: "The upstream API service timed out and no results were returned, please try again.",
        failCode: "500",
        failedAt: new Date().toISOString(),
      }),
      "test",
    );

    const def = whitelistDef(fs);
    const result = await def.handler({ asset_id: assetId, project_slug: "test" });
    const data = JSON.parse(result.content[0].text);
    expect(data.transcription).toBe("skipped_prior_failure");
    expect(data.status).toBe("whitelisted");
  });

  it("returns pipeline_pending when asset has no .original.analysis.json", async () => {
    const assetResult = await fs.createAsset("vid", "no-analysis", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    const def = whitelistDef(fs);
    const result = await def.handler({ asset_id: assetId, project_slug: "test" });
    const data = JSON.parse(result.content[0].text);
    expect(data.transcription).toBe("pipeline_pending");
    expect(data.status).toBe("whitelisted");
    expect(data.whitelisted_at).toBeDefined();
  });

  it("returns skipped when analysis present but no dialog", async () => {
    const assetResult = await fs.createAsset("vid", "no-dialog", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    await fs.writeFile(assetId, ".original.analysis.json", JSON.stringify({ duration: 10 }), "test");

    const def = whitelistDef(fs);
    const result = await def.handler({ asset_id: assetId, project_slug: "test" });
    const data = JSON.parse(result.content[0].text);
    expect(data.transcription).toBe("skipped");
    expect(data.dialog_quality).toBeDefined();
    expect(data.dialog_quality.hasDialog).toBe(false);
  });

  it("returns skipped_no_api_key when dialog exists but no KIE_API_KEY", async () => {
    const assetResult = await fs.createAsset("vid", "no-key", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    await fs.writeFile(assetId, ".original.analysis.json", JSON.stringify({ duration: 10 }), "test");
    const transcription = JSON.stringify({ text: "The quick brown fox jumps over the lazy dog" });
    await fs.writeFile(assetId, ".analysis.gpt4otrans.json", transcription, "test");

    const savedKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;

    try {
      const def = whitelistDef(fs);
      const result = await def.handler({ asset_id: assetId, project_slug: "test" });
      const data = JSON.parse(result.content[0].text);
      expect(data.transcription).toBe("skipped_no_api_key");
      expect(data.dialog_quality.hasDialog).toBe(true);
    } finally {
      if (savedKey !== undefined) {
        process.env.KIE_API_KEY = savedKey;
      }
    }
  });

  it("returns skipped_no_audio when dialog exists and KIE key set but no audio file", async () => {
    const assetResult = await fs.createAsset("vid", "no-audio", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    await fs.writeFile(assetId, ".original.analysis.json", JSON.stringify({ duration: 10 }), "test");
    const transcription = JSON.stringify({ text: "The quick brown fox jumps over the lazy dog" });
    await fs.writeFile(assetId, ".analysis.gpt4otrans.json", transcription, "test");

    const savedKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-fake-key";

    try {
      const def = whitelistDef(fs);
      const result = await def.handler({ asset_id: assetId, project_slug: "test" });
      const data = JSON.parse(result.content[0].text);
      expect(data.transcription).toBe("skipped_no_audio");
      expect(data.dialog_quality.hasDialog).toBe(true);
    } finally {
      if (savedKey !== undefined) {
        process.env.KIE_API_KEY = savedKey;
      } else {
        delete process.env.KIE_API_KEY;
      }
    }
  });

  it("whitelist non-video returns error via handler directly", async () => {
    const def = whitelistDef(fs);
    const result = await def.handler({ asset_id: "img-something", project_slug: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Only video assets");
  });

  it("whitelist nonexistent asset returns error via handler directly", async () => {
    const def = whitelistDef(fs);
    const result = await def.handler({ asset_id: "vid-nonexistent", project_slug: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Asset not found");
  });

  it("returns already_whitelisted on second whitelist call", async () => {
    const assetResult = await fs.createAsset("vid", "double-wl", "test");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.assetId;

    const def = whitelistDef(fs);
    const first = await def.handler({ asset_id: assetId, project_slug: "test" });
    const firstData = JSON.parse(first.content[0].text);
    expect(firstData.status).toBe("whitelisted");

    const second = await def.handler({ asset_id: assetId, project_slug: "test" });
    const secondData = JSON.parse(second.content[0].text);
    expect(secondData.status).toBe("already_whitelisted");
    expect(secondData.whitelisted_at).toBeDefined();
  });
});

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createFs } from "videocity-engine";

type TextContent = Array<{ type: string; text: string }>;

function parseResponse(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (result.isError) throw new Error((result.content as TextContent)[0].text);
  return JSON.parse((result.content as TextContent)[0].text);
}

describe("notebook capture tools", () => {
  let client: Client;
  let tempDir: string;
  let fs: ReturnType<typeof createFs>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-notebook-capture-"));
    client = await createTestClient(tempDir);
    fs = createFs({ projectsDir: tempDir });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj", notebook_id: "nb-1" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("activates a notebook target", async () => {
    const asset = await fs.createAsset("nb", "test notebook", "test-proj");
    const nbId = asset.ok ? asset.value.assetId : "nb-1";
    
    const result = await client.callTool({
      name: "activate_notebook",
      arguments: { project_slug: "test-proj", notebook_id: nbId },
    });
    expect(parseResponse(result)).toEqual({ success: true, notebook_id: nbId });

    const meta = await fs.readProjectMeta<{ notebook_id: string }>("last-active-notebook", "test-proj");
    expect(meta.ok).toBe(true);
    expect(meta.ok && meta.value).toEqual({ notebook_id: nbId });
  });

  it("updates and reads capture layout", async () => {
    const asset = await fs.createAsset("nb", "test notebook", "test-proj");
    const nbId = asset.ok ? asset.value.assetId : "nb-1";
    
    const layout = { "node-1": { x: 10, y: 20 } };
    const result = await client.callTool({
      name: "update_notebook_capture_layout",
      arguments: { project_slug: "test-proj", notebook_id: nbId, positions: layout },
    });
    expect(parseResponse(result)).toEqual({ success: true });

    const readResult = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: nbId },
    });
    expect(parseResponse(readResult).capture_layout).toEqual(layout);
  });

  it("extracts captures from action log", async () => {
    const asset = await fs.createAsset("nb", "test notebook", "test-proj");
    const nbId = asset.ok ? asset.value.assetId : "nb-1";

    // 1. Manually add a generation action with _notebook_capture envelope
    await fs.logAction(
      "generate-image",
      {
        _notebook_capture: {
          notebook_id: nbId,
          category: "generate",
          provider: "fal",
          inputs: { prompt: "A neon fox" },
          outcome: { assetIds: ["img-test-1"] },
        },
      },
      "test-proj"
    );

    // 2. Add an error action for that asset
    await fs.logAction(
      "job-error",
      { asset_id: "img-test-1", error: "Connection timeout" },
      "test-proj"
    );

    // 3. Add another action that has handler failure
    await fs.logAction(
      "generate-image-2",
      {
        _error: "Missing API key",
        _notebook_capture: {
          notebook_id: nbId,
          category: "edit",
          provider: "fal",
          inputs: { prompt: "Another" },
          outcome: { assetIds: [] },
        },
      },
      "test-proj"
    );

    const readResult = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: nbId },
    });
    const response = parseResponse(readResult);
    expect(response.captures).toHaveLength(2);
    
    // Reverse chronological normally, but we push them in order of the action log (which is newest first!)
    // wait, getActionLog returns newest first.
    // So the handler failure is first, then the successful generate.
    
    expect(response.captures[0].category).toBe("edit");
    expect(response.captures[0].status).toBe("failed");
    expect(response.captures[0].error).toBe("Missing API key");

    expect(response.captures[1].category).toBe("generate");
    expect(response.captures[1].status).toBe("failed");
    expect(response.captures[1].error).toBe("Connection timeout");
    expect(response.captures[1].assetId).toBe("img-test-1");
  });
});

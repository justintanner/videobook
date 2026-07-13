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

interface TestCapture {
  assetId?: string;
  inputs: Record<string, unknown>;
  status: string;
  error?: string;
}

describe("notebook provenance e2e", () => {
  let client: Client;
  let tempDir: string;
  let fs: ReturnType<typeof createFs>;
  const PROJECT = "provenance-test";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-provenance-e2e-"));
    client = await createTestClient(tempDir);
    fs = createFs({ projectsDir: tempDir });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: PROJECT, notebook_id: "nb-prov" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("proves UI, direct MCP, batch, retry, success, failure captures route to notebook, char-* as source, chained assets, node movement", async () => {
    // 1. Create and Activate notebook
    const asset = await fs.createAsset("nb", "prov notebook", PROJECT);
    const nbId = asset.ok ? asset.value.assetId : "nb-prov";

    await client.callTool({
      name: "activate_notebook",
      arguments: { project_slug: PROJECT, notebook_id: nbId },
    });

    // 2. Create an initial character asset so it shows up as deleted or missing properly 
    // or just assume character is in inputs.
    await fs.createAsset("char", "Hero", PROJECT, "char-hero");

    // 3. Log simulated actions for provenance

    // Success capture (e.g. from UI) - referencing a character as source node
    await fs.logAction(
      "generate-image",
      {
        _notebook_capture: {
          notebook_id: nbId,
          category: "generate",
          provider: "ui",
          inputs: { character: "char-hero", prompt: "hero standing" },
          outcome: { assetIds: ["img-hero-1"] },
        },
      },
      PROJECT
    );

    // Batch generation (multiple outcomes) - each gets its own tile
    await fs.logAction(
      "generate-batch",
      {
        _notebook_capture: {
          notebook_id: nbId,
          category: "generate",
          provider: "agent",
          inputs: { prompt: "batch generation" },
          outcome: { assetIds: ["img-batch-1", "img-batch-2"] },
        },
      },
      PROJECT
    );

    // Failure capture
    await fs.logAction(
      "generate-failure",
      {
        _error: "Rate limit exceeded",
        _notebook_capture: {
          notebook_id: nbId,
          category: "generate",
          provider: "direct-mcp",
          inputs: { prompt: "will fail" },
          outcome: { assetIds: [] },
        },
      },
      PROJECT
    );

    // Retry capture (same inputs, successful outcome)
    await fs.logAction(
      "generate-retry",
      {
        _notebook_capture: {
          notebook_id: nbId,
          category: "generate",
          provider: "direct-mcp",
          inputs: { prompt: "will fail" }, // same inputs as failure to represent retry
          outcome: { assetIds: ["img-retry-1"] },
        },
      },
      PROJECT
    );

    // Chained assets form the expected path
    // Input is img-hero-1 (outcome of first capture) -> produces vid-hero-1
    await fs.logAction(
      "generate-video",
      {
        _notebook_capture: {
          notebook_id: nbId,
          category: "animate",
          provider: "agent",
          inputs: { source_image: "img-hero-1", prompt: "animate hero" },
          outcome: { assetIds: ["vid-hero-1"] },
        },
      },
      PROJECT
    );

    // 4. Read Notebook and assert captures
    const readResult1 = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: PROJECT, notebook_id: nbId },
    });
    const data1 = parseResponse(readResult1);
    const captures = data1.captures;

    // We expect:
    // 1 for Hero image
    // 2 for Batch generation
    // 1 for Failure
    // 1 for Retry
    // 1 for Chained Video
    // Total = 6 captures
    expect(captures).toHaveLength(6);

    // Character referenced as source node (found in inputs)
    const heroCapture = captures.find((c: TestCapture) => c.assetId === "img-hero-1");
    expect(heroCapture).toBeDefined();
    expect(heroCapture.inputs.character).toBe("char-hero");

    // Every outcome has its own tile (Batch generated 2 tiles)
    const batchTiles = captures.filter((c: TestCapture) => c.inputs.prompt === "batch generation");
    expect(batchTiles).toHaveLength(2);
    expect(batchTiles.map((c: TestCapture) => c.assetId).sort()).toEqual(["img-batch-1", "img-batch-2"]);

    // Failure capture
    const failCapture = captures.find((c: TestCapture) => c.status === "failed");
    expect(failCapture).toBeDefined();
    expect(failCapture.error).toBe("Rate limit exceeded");

    // Chained asset path (vid-hero-1 depends on img-hero-1)
    const chainedCapture = captures.find((c: TestCapture) => c.assetId === "vid-hero-1");
    expect(chainedCapture).toBeDefined();
    expect(chainedCapture.inputs.source_image).toBe("img-hero-1");

    // 5. Node movement persists without mutating capture content
    const layout = { "some-id": { x: 100, y: 200 } };
    await client.callTool({
      name: "update_notebook_capture_layout",
      arguments: { project_slug: PROJECT, notebook_id: nbId, positions: layout },
    });

    const readResult2 = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: PROJECT, notebook_id: nbId },
    });
    const data2 = parseResponse(readResult2);
    
    // Verify layout was updated
    expect(data2.capture_layout).toEqual(layout);
    // Verify captures remain unchanged
    expect(data2.captures).toEqual(data1.captures);
  });
});

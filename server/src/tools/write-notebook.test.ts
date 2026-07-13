import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFs } from "videocity-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

interface PlanDefinition {
  properties: Record<string, unknown>;
  sequence: Array<{
    id: string;
    componentType: "task";
    type: "prompt" | "image" | "video" | "asset";
    name: string;
    properties: Record<string, unknown>;
  }>;
}

const NOTEBOOK_DEFINITION: PlanDefinition = {
  properties: { title: "Fox storyboard" },
  sequence: [
    {
      id: "prompt-1",
      componentType: "task",
      type: "prompt",
      name: "Idea",
      properties: { text: "A neon fox walks through a misted alley." },
    },
    {
      id: "image-1",
      componentType: "task",
      type: "image",
      name: "Key frame",
      properties: {
        model: "nano-banana-pro",
        provider: "google",
        values: {
          prompt: "A neon fox in the rain",
          image_slugs: ["@img-source"],
          first_frame_slug: "@img-first",
          video_slug: "@vid-reference",
        },
        inputs: ["prompt-1", "asset-source"],
        asset_ids: ["img-output"],
      },
    },
    {
      id: "asset-source",
      componentType: "task",
      type: "asset",
      name: "Source image",
      properties: { slug: "@img-source" },
    },
    {
      id: "video-1",
      componentType: "task",
      type: "video",
      name: "Motion",
      properties: {
        model: "veo-3.1",
        provider: "google",
        values: { prompt: "The fox walks forward." },
        asset_ids: ["vid-output"],
      },
    },
  ],
};

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as TextContent;
  return content[0].text;
}

describe("write_notebook tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-write-notebook-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj", name: "testnb" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("writes a ready notebook asset, mirrors markdown, and round-trips through read_notebook", async () => {
    const result = await client.callTool({
      name: "write_notebook",
      arguments: { project_slug: "test-proj", name: "testnb", definition: NOTEBOOK_DEFINITION },
    });

    if (result.isError) { console.error("WRITE ERROR:", resultText(result)); }
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(resultText(result))).toMatchObject({ ok: true, steps: 4 });
    const resultObj = JSON.parse(resultText(result));
    const sidecar = await readFile(join(tempDir, "test-proj", resultObj.notebook_id, ".notebook.json"), "utf8");
    expect(JSON.parse(sidecar)).toEqual({
      format: "notebook",
      schema_version: 1,
      definition: NOTEBOOK_DEFINITION,
    });
    const markdown = await readFile(join(tempDir, "test-proj", resultObj.notebook_id, "index.md"), "utf8");
    expect(markdown).toContain("Idea — prompt");
    expect(markdown).toContain("Key frame — image");
    expect(markdown).toContain("**Model:** nano-banana-pro");
    expect(markdown).toContain("**Inputs:** #1 Idea, @img-source");
    expect(markdown).toContain("**Asset:** @img-source");
    expect(markdown).toContain("@img-output");
    expect(markdown).toContain("> A neon fox in the rain");

    const assetsResult = await client.callTool({
      name: "list_assets",
      arguments: { project_slug: "test-proj", name: "testnb" },
    });
    const assets = JSON.parse(resultText(assetsResult)) as {
      assets: Array<{ id: string; type: string; status: string }>;
    };
    expect(assets.assets).toEqual(expect.arrayContaining([expect.objectContaining({
      id: resultObj.notebook_id,
      type: "notebook",
      status: "ready",
    })]));

    const readResult = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: resultObj.notebook_id },
    });
    expect(JSON.parse(resultText(readResult))).toEqual({
      exists: true,
      definition: NOTEBOOK_DEFINITION,
    });
  });

  it("succeeds when rewriting an identical definition", async () => {
    const first = await client.callTool({
      name: "write_notebook",
      arguments: { project_slug: "test-proj", definition: NOTEBOOK_DEFINITION },
    });
    const second = await client.callTool({
      name: "write_notebook",
      arguments: { project_slug: "test-proj", definition: NOTEBOOK_DEFINITION },
    });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
  });

  it("rejects invalid step ids and types", async () => {
    const duplicateIds = {
      properties: {},
      sequence: [
        { id: "same", componentType: "task", type: "prompt", name: "One", properties: {} },
        { id: "same", componentType: "task", type: "image", name: "Two", properties: {} },
      ],
    };
    const invalidType = {
      properties: {},
      sequence: [
        { id: "bad", componentType: "task", type: "audio", name: "Bad", properties: {} },
      ],
    };

    const duplicateResult = await client.callTool({
      name: "write_notebook",
      arguments: { project_slug: "test-proj", definition: duplicateIds },
    });
    const typeResult = await client.callTool({
      name: "write_notebook",
      arguments: { project_slug: "test-proj", definition: invalidType },
    });

    expect(duplicateResult.isError).toBe(true);
    expect(typeResult.isError).toBe(true);
  });

  it("overwrites a legacy sidecar", async () => {
    const fsObj = createFs({ projectsDir: tempDir });
    const asset = await fsObj.createAsset("nb", "legacy", "test-proj");
    const notebookDir = join(tempDir, "test-proj", asset.value.assetId);
    await writeFile(join(notebookDir, ".notebook.json"), JSON.stringify({ formula: "char_swap" }));
    
    // Now use this assetId for the test
    const result = await client.callTool({
      name: "write_notebook",
      arguments: { project_slug: "test-proj", notebook_id: asset.value.assetId, definition: NOTEBOOK_DEFINITION },
    });
    
    expect(result.isError).toBeFalsy();
    const sidecar = await readFile(join(notebookDir, ".notebook.json"), "utf8");
    expect(JSON.parse(sidecar)).toMatchObject({ format: "notebook", definition: NOTEBOOK_DEFINITION });
  });
});

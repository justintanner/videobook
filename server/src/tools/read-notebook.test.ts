import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
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

interface ReadPlanResponse {
  exists: boolean;
  legacy?: boolean;
  definition: PlanDefinition;
  captures: unknown[];
  capture_layout: Record<string, unknown>;
}

const EMPTY_DEFINITION: PlanDefinition = { properties: {}, sequence: [] };

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
        inputs: ["asset-source"],
        values: { prompt: "A neon fox", image_slugs: ["@img-source"] },
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
  ],
};

async function seedPlanSidecar(
  projectsDir: string,
  projectSlug: string,
  sidecar: unknown,
): Promise<void> {
  const notebookDir = join(projectsDir, projectSlug, "nb-test");
  await mkdir(notebookDir, { recursive: true });
  await writeFile(join(notebookDir, ".notebook.json"), JSON.stringify(sidecar, null, 2));
}

function readResponse(result: Awaited<ReturnType<Client["callTool"]>>): ReadPlanResponse {
  const content = result.content as TextContent;
  return JSON.parse(content[0].text) as ReadPlanResponse;
}

describe("read_notebook tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-read-plan-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj", notebook_id: "nb-test" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns a valid notebook sidecar", async () => {
    await seedPlanSidecar(tempDir, "test-proj", {
      format: "notebook",
      schema_version: 1,
      definition: NOTEBOOK_DEFINITION,
    });

    const result = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: "nb-test" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({ exists: true, definition: NOTEBOOK_DEFINITION, captures: [], capture_layout: {} });
  });

  it("returns an empty notebook definition when the plan is missing", async () => {
    const result = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: "nb-test" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({ exists: false, definition: EMPTY_DEFINITION, captures: [], capture_layout: {} });
  });

  it("marks a legacy formula sidecar without changing it", async () => {
    await seedPlanSidecar(tempDir, "test-proj", {
      formula: "char_swap",
      scenes: [],
      total_duration_s: 0,
    });

    const result = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: "nb-test" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({
      exists: false,
      legacy: true,
      definition: EMPTY_DEFINITION,
      captures: [],
      capture_layout: {},
    });
  });

  it("marks corrupt JSON as legacy-empty", async () => {
    const notebookDir = join(tempDir, "test-proj", "nb-test");
    await mkdir(notebookDir, { recursive: true });
    await writeFile(join(notebookDir, ".notebook.json"), "{");

    const result = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "test-proj", notebook_id: "nb-test" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({
      exists: false,
      legacy: true,
      definition: EMPTY_DEFINITION,
      captures: [],
      capture_layout: {},
    });
  });

  it("returns an error when the project does not exist", async () => {
    const result = await client.callTool({
      name: "read_notebook",
      arguments: { project_slug: "no-such-project" },
    });

    expect(result.isError).toBe(true);
  });
});

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
    type: "prompt" | "image" | "video";
    name: string;
    properties: Record<string, unknown>;
  }>;
}

interface ReadPlanResponse {
  exists: boolean;
  legacy?: boolean;
  definition: PlanDefinition;
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
        values: { prompt: "A neon fox", image_slugs: ["@img-source"] },
        asset_ids: ["img-output"],
      },
    },
  ],
};

async function seedPlanSidecar(
  projectsDir: string,
  projectSlug: string,
  sidecar: unknown,
): Promise<void> {
  const planDir = join(projectsDir, projectSlug, "plan");
  await mkdir(planDir, { recursive: true });
  await writeFile(join(planDir, ".plan.json"), JSON.stringify(sidecar, null, 2));
}

function readResponse(result: Awaited<ReturnType<Client["callTool"]>>): ReadPlanResponse {
  const content = result.content as TextContent;
  return JSON.parse(content[0].text) as ReadPlanResponse;
}

describe("read_plan tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-read-plan-test-"));
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

  it("returns a valid notebook sidecar", async () => {
    await seedPlanSidecar(tempDir, "test-proj", {
      format: "notebook",
      schema_version: 1,
      definition: NOTEBOOK_DEFINITION,
    });

    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({ exists: true, definition: NOTEBOOK_DEFINITION });
  });

  it("returns an empty notebook definition when the plan is missing", async () => {
    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({ exists: false, definition: EMPTY_DEFINITION });
  });

  it("marks a legacy formula sidecar without changing it", async () => {
    await seedPlanSidecar(tempDir, "test-proj", {
      formula: "char_swap",
      scenes: [],
      total_duration_s: 0,
    });

    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({
      exists: false,
      legacy: true,
      definition: EMPTY_DEFINITION,
    });
  });

  it("marks corrupt JSON as legacy-empty", async () => {
    const planDir = join(tempDir, "test-proj", "plan");
    await mkdir(planDir, { recursive: true });
    await writeFile(join(planDir, ".plan.json"), "{");

    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    expect(readResponse(result)).toEqual({
      exists: false,
      legacy: true,
      definition: EMPTY_DEFINITION,
    });
  });

  it("returns an error when the project does not exist", async () => {
    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "no-such-project" },
    });

    expect(result.isError).toBe(true);
  });
});

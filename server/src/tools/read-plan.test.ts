import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

interface ReadPlanResponse {
  formula?: string;
  scenes: Array<{ start: number; end: number; visual: string }>;
  total_duration_s: number;
  max_scene_seconds: number;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  model: string;
}

const FIXTURE_SIDECAR: ReadPlanResponse = {
  scenes: [
    { start: 0, end: 8.5, visual: "A neon fox padding through a misted cyberpunk alley at dawn" },
    { start: 8.5, end: 17, visual: "Wide overhead shot of the alley as steam curls between buildings" },
  ],
  total_duration_s: 17,
  max_scene_seconds: 15,
  source_asset_id: "vid-test-source",
  characters: [],
  model: "gpt-test-model",
};

async function seedPlanSidecar(
  projectsDir: string,
  projectSlug: string,
  sidecar: ReadPlanResponse,
): Promise<void> {
  const planDir = join(projectsDir, projectSlug, "plan");
  await mkdir(planDir, { recursive: true });
  await writeFile(join(planDir, ".plan.json"), JSON.stringify(sidecar, null, 2));
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

  it("returns the parsed plan sidecar when it exists", async () => {
    await seedPlanSidecar(tempDir, "test-proj", FIXTURE_SIDECAR);

    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed: ReadPlanResponse = JSON.parse(content[0].text);
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.scenes[0].visual).toBe(FIXTURE_SIDECAR.scenes[0].visual);
    expect(parsed.scenes[1].start).toBe(8.5);
    expect(parsed.formula).toBe("char_swap");
    expect(parsed.total_duration_s).toBe(17);
    expect(parsed.max_scene_seconds).toBe(15);
    expect(parsed.source_asset_id).toBe("vid-test-source");
    expect(parsed.model).toBe("gpt-test-model");
  });

  it("returns an error when no plan exists yet", async () => {
    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "test-proj" },
    });

    expect(result.isError).toBe(true);
  });

  it("returns an error when the project does not exist", async () => {
    const result = await client.callTool({
      name: "read_plan",
      arguments: { project_slug: "no-such-project" },
    });

    expect(result.isError).toBe(true);
  });
});

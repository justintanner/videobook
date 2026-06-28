import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  startPlanProgress,
  updatePlanProgress,
  finishPlanProgress,
} from "../plan-progress.js";

type TextContent = Array<{ type: string; text: string }>;

interface ProgressResponse {
  status: string;
  text: string;
  error: string | null;
}

// The in-memory transport runs the server in this process, so the plan-progress
// registry singleton is the same instance the test drives directly — a real
// round-trip with no mocks.
async function readProgress(client: Client, slug: string): Promise<ProgressResponse> {
  const result = await client.callTool({
    name: "read_plan_progress",
    arguments: { project_slug: slug },
  });
  expect(result.isError).toBeFalsy();
  const content = result.content as TextContent;
  return JSON.parse(content[0].text);
}

describe("read_plan_progress tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-plan-progress-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns idle when there is no run for the project", async () => {
    const progress = await readProgress(client, "no-run-proj");
    expect(progress.status).toBe("idle");
    expect(progress.text).toBe("");
  });

  it("streams generating text, then flips to done", async () => {
    const slug = "streaming-proj";
    startPlanProgress(slug);
    updatePlanProgress(slug, '{"visuals":[{"visual":"a man stands');

    let progress = await readProgress(client, slug);
    expect(progress.status).toBe("generating");
    expect(progress.text).toContain("a man stands");

    finishPlanProgress(slug, "done");
    progress = await readProgress(client, slug);
    expect(progress.status).toBe("done");
  });

  it("records a failure with its error message", async () => {
    const slug = "failed-proj";
    startPlanProgress(slug);
    finishPlanProgress(slug, "failed", "boom");

    const progress = await readProgress(client, slug);
    expect(progress.status).toBe("failed");
    expect(progress.error).toBe("boom");
  });

  it("ignores late deltas after a run finalizes", async () => {
    const slug = "late-delta-proj";
    startPlanProgress(slug);
    finishPlanProgress(slug, "done");
    updatePlanProgress(slug, "stale text that must not appear");

    const progress = await readProgress(client, slug);
    expect(progress.status).toBe("done");
    expect(progress.text).not.toContain("stale");
  });
});

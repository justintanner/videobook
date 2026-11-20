import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { runFfmpeg } from "../ffmpeg.js";
import { toolSpendsMoney } from "../paid-tools.js";
import { waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";

function data(result: { content?: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe("apply_builtin_sfx tool", () => {
  let client: Client;
  let engine: Engine;
  let dir: string;
  let assetId: string;
  let bookId: string;
  const keys = { ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

  beforeAll(async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.OPENAI_API_KEY;
    dir = await mkdtemp(join(tmpdir(), "builtin-sfx-tool-"));
    const fixture = join(dir, "source.mp4");
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=black:size=160x90:rate=24:duration=3", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:seed=1:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", fixture]);
    engine = createEngineForTest(dir);
    bookId = engine.book.get().bookId;
    const asset = await engine.artifacts.create("video", "SFX target");
    if (!asset.ok) throw new Error(asset.error.message);
    assetId = asset.value.artifactId;
    const written = await engine.files.write(assetId, "original.mp4", await readFile(fixture));
    if (!written.ok) throw new Error(written.error.message);
    client = await createTestClient(dir);
  });

  afterAll(async () => {
    await client?.close();
    for (const [name, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("mixes without provider keys, drops late cues, and queues forced reprocessing", async () => {
    const result = await client.callTool({ name: "apply_builtin_sfx", arguments: { book_id: bookId, asset_id: `@${assetId}`, sfx: [{ sound: "zoom_in", timestamp: 1 }, { sound: "ding", timestamp: 99 }] } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(data(result)).toMatchObject({ asset_id: assetId, status: "completed", applied: 1, dropped: 1 });
    await waitForBookQueuesIdleForTests();
    const jobs = engine.jobs.queue.list({ type: "process_video", artifactId: assetId });
    expect(jobs.some((job) => job.payload.force === true && (job.payload.provenance as Record<string, unknown>)?.origin === "apply_builtin_sfx")).toBe(true);
  }, testBudget(60_000));

  it("explains why all cues were dropped", async () => {
    const result = await client.callTool({ name: "apply_builtin_sfx", arguments: { book_id: bookId, asset_id: assetId, sfx: [{ sound: "pop", timestamp: 2.95 }] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("end or beyond");
  });

  it.each([[], [{ sound: "unknown", timestamp: 0 }], [{ sound: "pop", timestamp: -1 }], [{ sound: "pop", timestamp: 0, volume: 101 }], Array.from({ length: 17 }, () => ({ sound: "pop", timestamp: 0 }))].map((sfx) => [sfx]))("rejects invalid cue input %#", async (sfx) => {
    const result = await client.callTool({ name: "apply_builtin_sfx", arguments: { book_id: bookId, asset_id: assetId, sfx } });
    expect(result.isError).toBe(true);
  });

  it("is free and has no generation confirmation in the action catalog", async () => {
    expect(toolSpendsMoney("apply_builtin_sfx")).toBe(false);
    const result = await client.callTool({ name: "list_workspace_actions", arguments: { detail: "full", ids: ["tool.apply_builtin_sfx"] } });
    const actions = data(result).actions as Array<{ id: string; confirmation?: string }>;
    const action = actions.find((entry) => entry.id === "tool.apply_builtin_sfx");
    expect(action).toBeDefined();
    expect(action?.confirmation).toBe("none");
  });

  it("accepts and mixes power_down and error cues into a fixture clip", async () => {
    const result = await client.callTool({
      name: "apply_builtin_sfx",
      arguments: {
        book_id: bookId,
        asset_id: assetId,
        sfx: [{ sound: "power_down", timestamp: 0.5 }, { sound: "error", timestamp: 2.0 }],
      },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(data(result)).toMatchObject({ asset_id: assetId, status: "completed", applied: 2, dropped: 0 });
    await waitForBookQueuesIdleForTests();
  }, testBudget(60_000));
});

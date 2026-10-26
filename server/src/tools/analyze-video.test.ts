import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { testBudget } from "../test-budget.js";

type TextContent = Array<{ type: string; text: string }>;

const ANALYSIS = {
  summary: "A man answers a phone in a kitchen.",
  scenes: [{ timestamp: 0, description: "Phone call", tags: ["phone"] }],
  tags: ["phone", "kitchen"],
  mood: "tense",
  subjects: ["man"],
  setting: "a kitchen",
};

describe("analyze_video tool", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    await queue.start();
  }, testBudget(30_000));

  afterAll(async () => {
    await queue.stop();
  }, testBudget(30_000));

  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-analyze-video-"));
    engine = createEngineForTest(tempDir);
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "analyze-proj" },
    });
  }, testBudget(120_000));

  afterEach(async () => {
    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    else delete process.env.OPENAI_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(120_000));

  async function createVideoAsset(label: string): Promise<string> {
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      "original.mp4",
      Buffer.from("fake-video"),
    );
    if (!written.ok) throw new Error(written.error.message);
    return created.value.artifactId;
  }

  async function callAnalyze(
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const result = await client.callTool({
      name: "analyze_video",
      arguments: { book_id: "analyze-proj", ...args },
    });
    return {
      isError: result.isError === true,
      text: (result.content as TextContent)[0].text,
    };
  }

  it("errors when OPENAI_API_KEY is not set", async () => {
    const assetId = await createVideoAsset("keyless");
    const result = await callAnalyze({ asset_id: assetId });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("OPENAI_API_KEY");
  }, testBudget(30_000));

  it("rejects non-video artifacts", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const created = await engine.artifacts.create("script", "notes");
    if (!created.ok) throw new Error(created.error.message);
    const result = await callAnalyze({ asset_id: created.value.artifactId });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("only accepts video artifacts");
  }, testBudget(30_000));

  it("refuses a video artifact that has no video file yet", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const created = await engine.artifacts.create("video", "pending clip");
    if (!created.ok) throw new Error(created.error.message);
    const result = await callAnalyze({ asset_id: created.value.artifactId });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("has no video file yet");
  }, testBudget(30_000));

  it("enqueues an analysis job for a video artifact", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const assetId = await createVideoAsset("fresh");
    const result = await callAnalyze({ asset_id: assetId });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text) as {
      status: string;
      job_id: number;
      asset_id: string;
    };
    expect(parsed.status).toBe("queued");
    expect(parsed.asset_id).toBe(assetId);
    expect(parsed.job_id).toEqual(expect.any(Number));
  }, testBudget(30_000));

  it("skips assets that already carry an analysis unless forced", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const assetId = await createVideoAsset("analyzed");
    const written = await engine.files.write(
      assetId,
      ".original.analysis.json",
      JSON.stringify(ANALYSIS),
    );
    if (!written.ok) throw new Error(written.error.message);

    const skipped = await callAnalyze({ asset_id: assetId });
    expect(skipped.isError).toBe(false);
    expect(JSON.parse(skipped.text).status).toBe("cached");

    const forced = await callAnalyze({ asset_id: assetId, force: true });
    expect(forced.isError).toBe(false);
    expect(JSON.parse(forced.text).status).toBe("queued");
  }, testBudget(30_000));
});

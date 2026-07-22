import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("insert_timeline_slot tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
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

  it("inserts an empty slot before the selected slot and preserves metadata", async () => {
    const audio = [
      { id: "aud-1", slug: "aud-music", startFrame: 10, durationFrames: 120, volume: 80 },
    ];
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [
          { slug: "vid-intro", volume: 75 },
          { slug: "vid-outro", audioFadeIn: 200 },
        ],
        audio,
        render: "portrait",
        currentOrientation: "square",
      },
    });

    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s02", position: "before" },
    });

    expect(result.isError).toBeFalsy();
    const config = JSON.parse((result.content as TextContent)[0].text);
    expect(config.slots).toEqual([
      { slug: "vid-intro", volume: 75 },
      { slug: "" },
      { slug: "vid-outro", audioFadeIn: 200 },
    ]);
    expect(config.audio).toEqual(audio);
    expect(config.render).toBe("portrait");
    expect(config.currentOrientation).toBe("square");
  });

  it("inserts an empty slot after the selected slot", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-a" }, { slug: "vid-b" }, { slug: "vid-c" }],
      },
    });

    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s02", position: "after" },
    });

    expect(result.isError).toBeFalsy();
    const config = JSON.parse((result.content as TextContent)[0].text);
    expect(config.slots).toEqual([
      { slug: "vid-a" },
      { slug: "vid-b" },
      { slug: "" },
      { slug: "vid-c" },
    ]);
  });

  it("pads through a displayed virtual slot before inserting", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: { project_slug: "test-proj", slots: [{ slug: "vid-a" }] },
    });

    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s03", position: "after" },
    });

    expect(result.isError).toBeFalsy();
    const config = JSON.parse((result.content as TextContent)[0].text);
    expect(config.slots).toEqual([
      { slug: "vid-a" },
      { slug: "" },
      { slug: "" },
      { slug: "" },
    ]);
  });

  it.each(["slot2", "s00"])("rejects invalid slot identifier %s", async (slot) => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { project_slug: "test-proj", slot, position: "before" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Invalid slot format");
  });

  it("returns an error for a nonexistent project", async () => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { project_slug: "missing", slot: "s01", position: "after" },
    });

    expect(result.isError).toBe(true);
  });
});

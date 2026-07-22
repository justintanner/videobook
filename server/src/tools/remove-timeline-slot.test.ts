import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("remove_timeline_slot tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-remove-timeline-slot-"));
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

  it("removes a filled slot, shifts later slots, and preserves timeline settings", async () => {
    const audio = [
      { id: "aud-1", slug: "aud-music", startFrame: 10, durationFrames: 120, volume: 80 },
    ];
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [
          { slug: "vid-a", volume: 75 },
          { slug: "vid-b", audioFadeIn: 200 },
          { slug: "vid-c", audioFadeOut: 300 },
        ],
        audio,
        render: "portrait",
        currentOrientation: "square",
      },
    });

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s02" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([
      { slug: "vid-a", volume: 75 },
      { slug: "vid-c", audioFadeOut: 300 },
    ]);
    expect(parsed.audio).toEqual(audio);
    expect(parsed.render).toBe("portrait");
    expect(parsed.currentOrientation).toBe("square");
    expect(parsed.removed_slot).toBe("s02");
    expect(parsed.removed_asset_id).toBe("vid-b");
    expect(parsed.trimmed_trailing_slots).toBe(0);
  });

  it("removes an internal empty and trims every trailing empty", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [
          { slug: "vid-a" },
          { slug: "" },
          { slug: "vid-b" },
          { slug: "" },
          { slug: "" },
        ],
      },
    });

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s02" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([{ slug: "vid-a" }, { slug: "vid-b" }]);
    expect(parsed.removed_asset_id).toBeNull();
    expect(parsed.trimmed_trailing_slots).toBe(2);
  });

  it("removing the last filled slot also removes newly trailing gaps", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [
          { slug: "vid-a" },
          { slug: "" },
          { slug: "vid-b" },
          { slug: "" },
          { slug: "" },
        ],
      },
    });

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s03" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([{ slug: "vid-a" }]);
    expect(parsed.trimmed_trailing_slots).toBe(3);
  });

  it("removing the only stored slot leaves an empty timeline", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-a" }],
      },
    });

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([]);
  });

  it.each(["slot2", "s00"])("rejects invalid slot identifier %s", async (slot) => {
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "test-proj", slot },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Invalid slot format");
  });

  it("rejects virtual slots and timelines that do not exist", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-a" }],
      },
    });

    const virtual = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "test-proj", slot: "s02" },
    });
    expect(virtual.isError).toBe(true);
    expect((virtual.content as TextContent)[0].text).toContain("stored slots");

    const missing = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { project_slug: "missing", slot: "s01" },
    });
    expect(missing.isError).toBe(true);
  });
});

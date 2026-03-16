import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("get_timeline tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
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

  it("returns empty slots and default render when no timeline set", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data).toEqual({ slots: [], render: "landscape" });
  });

  it("returns matching data after edit_timeline", async () => {
    const slots = [
      { slug: "vid-intro", volume: 0.8 },
      { slug: "vid-outro", audioFadeOut: 500 },
    ];
    await client.callTool({
      name: "edit_timeline",
      arguments: { project_slug: "test-proj", slots, render: "portrait" },
    });

    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slots).toEqual(slots);
    expect(data.render).toBe("portrait");
  });

  it("wraps old array format with default render orientation", async () => {
    // Simulate legacy data: timeline stored as a plain array of slots
    const oldData = [{ slug: "vid-legacy" }, { slug: "vid-old" }];
    await writeFile(
      join(tempDir, "test-proj", ".timeline.json"),
      JSON.stringify(oldData, null, 2),
    );

    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slots).toEqual(oldData);
    expect(data.render).toBe("landscape");
  });

  it("round-trips: edit then get returns matching data", async () => {
    const slots = [{ slug: "vid-a" }, { slug: "vid-b", volume: 1.0, audioFadeIn: 200 }];
    await client.callTool({
      name: "edit_timeline",
      arguments: { project_slug: "test-proj", slots, render: "square" },
    });

    const result = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slots).toEqual(slots);
    expect(data.render).toBe("square");
  });
});

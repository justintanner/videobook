import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("edit_timeline tool", () => {
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

  it("sets timeline with slots and returns path", async () => {
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-intro" }, { slug: "vid-outro", volume: 0.5 }],
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.path).toBeTruthy();
    expect(data.path).toContain("test-proj");
  });

  it("sets timeline with slots and render orientation", async () => {
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-hero" }],
        render: "portrait",
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.path).toBeTruthy();
  });

  it("preserves audio and currentOrientation when a partial update omits them", async () => {
    const audio = [
      { id: "aud-1", slug: "aud-music", startFrame: 0, durationFrames: 120, volume: 0.8 },
    ];
    const first = await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-intro" }],
        render: "portrait",
        audio,
        currentOrientation: "portrait",
      },
    });
    expect(first.isError).toBeFalsy();

    // Orientation-style update: slots + render only, no audio/currentOrientation.
    const second = await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-intro" }],
        render: "landscape",
      },
    });
    expect(second.isError).toBeFalsy();

    const readBack = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    expect(readBack.isError).toBeFalsy();
    const content = readBack.content as Array<{ type: string; text: string }>;
    const config = JSON.parse(content[0].text);
    expect(config.render).toBe("landscape");
    expect(config.audio).toEqual(audio);
    expect(config.currentOrientation).toBe("portrait");
  });

  it("clears audio when an explicit empty array is sent", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-intro" }],
        audio: [{ id: "aud-1", slug: "aud-music", startFrame: 0, durationFrames: 120 }],
      },
    });
    const cleared = await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-intro" }],
        audio: [],
      },
    });
    expect(cleared.isError).toBeFalsy();

    const readBack = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    const content = readBack.content as Array<{ type: string; text: string }>;
    const config = JSON.parse(content[0].text);
    // The engine omits the audio key entirely when no clips remain.
    expect(config.audio ?? []).toEqual([]);
  });

  it("returns error for nonexistent project", async () => {
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        project_slug: "no-such-project",
        slots: [{ slug: "vid-intro" }],
      },
    });
    expect(result.isError).toBe(true);
  });
});

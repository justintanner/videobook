import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface ActivityEntry {
  hash: string;
  action: string;
  source: "action" | "snapshot";
  rewindable: boolean;
}

async function readActivity(client: Client): Promise<ActivityEntry[]> {
  const result = await client.callTool({
    name: "project_activity",
    arguments: { project_slug: "test-proj", limit: 100 },
  });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as ActivityEntry[];
}

async function waitForActivity(
  client: Client,
  predicate: (entries: ActivityEntry[]) => boolean,
): Promise<ActivityEntry[]> {
  for (let i = 0; i < 20; i++) {
    const entries = await readActivity(client);
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readActivity(client);
}

describe("project_activity tool", () => {
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

  it("returns project-changing actions and snapshots, excluding read-only calls", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const upload = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse((upload.content as Array<{ type: string; text: string }>)[0].text) as { asset_id: string };

    await client.callTool({
      name: "asset_manifest",
      arguments: { project_slug: "test-proj", asset_id: uploaded.asset_id },
    });

    const entries = await waitForActivity(
      client,
      (activity) => activity.some((entry) => entry.action === "tool-upload-file"),
    );

    expect(entries.some((entry) => entry.action === "tool-upload-file" && entry.source === "action")).toBe(true);
    expect(entries.some((entry) => entry.source === "snapshot")).toBe(true);
    expect(entries.some((entry) => entry.action === "tool-asset-manifest")).toBe(false);
    expect(entries.every((entry) => entry.rewindable)).toBe(true);
    expect(entries.some((entry) => entry.source === "snapshot" && /^write/i.test(entry.action))).toBe(false);
  });
});

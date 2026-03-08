import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("rewind_project tool", () => {
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

  it("rewinds a project to an earlier commit", async () => {
    // Get initial commit
    const historyResult1 = await client.callTool({
      name: "project_history",
      arguments: { project_slug: "test-proj" },
    });
    const initialCommits = JSON.parse(
      (historyResult1.content as Array<{ type: string; text: string }>)[0].text
    );
    const initialHash = initialCommits[initialCommits.length - 1].hash;

    // Upload a file to create a new commit
    const data = Buffer.from("fake-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });

    // Rewind to initial commit
    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: initialHash, project_slug: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.status).toBe("rewound");
    expect(parsed.project).toBe("test-proj");
    expect(parsed.commit).toBe(initialHash);
  });

  it("returns error for invalid commit hash", async () => {
    const result = await client.callTool({
      name: "rewind_project",
      arguments: {
        commit_hash: "0000000000000000000000000000000000000000",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
  });
});

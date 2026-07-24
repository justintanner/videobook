import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Engine } from "videobook-engine";

describe("rewind_project tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    fs?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("rewinds a project to an earlier commit", async () => {
    // Get initial commit
    const historyResult1 = await client.callTool({
      name: "project_history",
      arguments: { book_id: "test-proj" },
    });
    const initialCommits = JSON.parse(
      (historyResult1.content as Array<{ type: string; text: string }>)[0].text
    );
    const initialHash = initialCommits[initialCommits.length - 1].hash;

    // Upload a file to create a new commit
    const data = Buffer.from("fake-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });

    // Rewind to initial commit
    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: initialHash, book_id: "test-proj" },
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
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("not found in project history");
  });

  it("rewinds using a short hash prefix", async () => {
    const historyResult = await client.callTool({
      name: "project_history",
      arguments: { book_id: "test-proj" },
    });
    const commits = JSON.parse(
      (historyResult.content as Array<{ type: string; text: string }>)[0].text
    );
    const fullHash = commits[commits.length - 1].hash as string;

    const data = Buffer.from("fake-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });

    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: fullHash.slice(0, 7), book_id: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.status).toBe("rewound");
    expect(parsed.commit).toBe(fullHash);
  });

  it("rejects a hash shorter than 7 characters", async () => {
    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: "abc12", book_id: "test-proj" },
    });
    expect(result.isError).toBe(true);
  });

  it("aborts queued project jobs before rewinding", async () => {
    const historyResult = await client.callTool({
      name: "project_history",
      arguments: { book_id: "test-proj" },
    });
    const commits = JSON.parse(
      (historyResult.content as Array<{ type: string; text: string }>)[0].text
    );
    const targetHash = commits[0].hash as string;

    await fs.jobs.queue.enqueue({
      type: "never_run",
      payload: { type: "never_run", bookId: "test-proj" },
      dedupeKey: null,
    });

    const result = await client.callTool({
      name: "rewind_project",
      arguments: { commit_hash: targetHash, book_id: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.status).toBe("rewound");
    expect(parsed.aborted_jobs).toBe(1);
  });
});

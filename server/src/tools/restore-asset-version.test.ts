import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

describe("restore_asset_version tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("restores an asset to a previous version", async () => {
    // Upload initial version
    const data1 = Buffer.from("version-one").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data: data1 },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );
    const stableArtifactId = uploaded.artifactId as string;

    // Get the commit hash for the initial version
    const historyResult = await client.callTool({
      name: "asset_history",
      arguments: { asset_id: uploaded.assetId, book_id: "test-proj" },
    });
    const commits = JSON.parse(
      (historyResult.content as Array<{ type: string; text: string }>)[0].text
    );
    const firstCommit = commits[commits.length - 1].hash;

    // Delete the asset to create a different state
    await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: uploaded.assetId, book_id: "test-proj" },
    });

    // Restore to the first version
    const result = await client.callTool({
      name: "restore_asset_version",
      arguments: {
        asset_id: stableArtifactId,
        commit_hash: firstCommit,
        book_id: "test-proj",
      },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.status).toBe("restored");
    expect(parsed.asset_id).toBe(stableArtifactId);
    expect(parsed.from_commit).toBe(firstCommit);
    expect(parsed.new_commit).toBeDefined();

    const repeatResult = await client.callTool({
      name: "restore_asset_version",
      arguments: {
        asset_id: stableArtifactId,
        commit_hash: firstCommit,
        book_id: "test-proj",
      },
    });
    expect(repeatResult.isError).toBeFalsy();
    const repeatParsed = JSON.parse(
      (repeatResult.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(repeatParsed.status).toBe("restored");
    expect(repeatParsed.asset_id).toBe(stableArtifactId);
    expect(repeatParsed.from_commit).toBe(firstCommit);
    expect(repeatParsed.new_commit).toBeDefined();
  });

  it("returns error for invalid commit hash", async () => {
    const result = await client.callTool({
      name: "restore_asset_version",
      arguments: {
        asset_id: "img-nonexistent",
        commit_hash: "0000000000000000000000000000000000000000",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
  });
});

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("export_asset_to_project tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "source-proj" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "target-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports an asset to a different project", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "source-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "export_asset_to_project",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "source-proj",
        target_project: "target-proj",
      },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.source_asset_id).toBe(uploaded.assetId);
    expect(parsed.new_asset_id).toMatch(/^img-/);
    expect(parsed.source_project).toBe("source-proj");
    expect(parsed.target_project).toBe("target-proj");

    // Verify asset exists in target project
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, project_slug: "target-proj" },
    });
    const manifestParsed = JSON.parse(
      (manifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(manifestParsed.files.some((f: { name: string }) => f.name === "original.png")).toBe(true);
  });

  it("returns error when source and target are the same project", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "source-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "export_asset_to_project",
      arguments: {
        asset_id: uploaded.assetId,
        project_slug: "source-proj",
        target_project: "source-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("duplicate_asset");
  });

  it("returns error for nonexistent source asset", async () => {
    const result = await client.callTool({
      name: "export_asset_to_project",
      arguments: {
        asset_id: "img-no-such-asset",
        project_slug: "source-proj",
        target_project: "target-proj",
      },
    });
    expect(result.isError).toBe(true);
  });
});

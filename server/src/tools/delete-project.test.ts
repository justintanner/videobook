import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("delete_project tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("deletes an existing project", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "alpha" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "beta" },
    });

    const result = await client.callTool({
      name: "delete_project",
      arguments: { project_slug: "alpha" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slug).toBe("alpha");
    expect(data.default_project_slug).toBe("beta");

    const projectsResult = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    const projectsContent = projectsResult.content as Array<{ type: string; text: string }>;
    const projects = JSON.parse(projectsContent[0].text) as Array<{ slug: string }>;
    expect(projects.map((project) => project.slug)).toEqual(["beta"]);
  });

  it("returns error for nonexistent project", async () => {
    const result = await client.callTool({
      name: "delete_project",
      arguments: { project_slug: "missing" },
    });
    expect(result.isError).toBe(true);
  });
});

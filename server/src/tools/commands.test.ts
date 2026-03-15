import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface Command {
  command: string;
  description: string;
  category: string;
  icon: string;
  size: string;
  variant: string;
  chevron: string;
  params: Array<{ name: string; type: string; required: boolean; description: string }>;
  example?: string;
  mcpTool?: { tool: string; autoInject?: string[] };
  uiAction?: string;
  visibleWhen?: { assetPrefix?: string[] };
}

describe("commands tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns array of command objects", async () => {
    const result = await client.callTool({
      name: "commands",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const commands: Command[] = JSON.parse(content[0].text);
    expect(Array.isArray(commands)).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
  });

  it("each command has required fields", async () => {
    const result = await client.callTool({
      name: "commands",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const commands: Command[] = JSON.parse(content[0].text);

    for (const cmd of commands) {
      expect(cmd.command).toBeTruthy();
      expect(cmd.command.startsWith("/")).toBe(true);
      expect(cmd.description).toBeTruthy();
      expect(["action", "project", "context_menu"]).toContain(cmd.category);
      expect(cmd.icon).toBeTruthy();
      expect(["sm", "default", "lg"]).toContain(cmd.size);
      expect(["default", "violet"]).toContain(cmd.variant);
      expect(["right", "down"]).toContain(cmd.chevron);
      expect(Array.isArray(cmd.params)).toBe(true);
    }
  });

  it("includes hardcoded commands", async () => {
    const result = await client.callTool({
      name: "commands",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const commands: Command[] = JSON.parse(content[0].text);
    const names = commands.map((c) => c.command);

    expect(names).toContain("/generate");
    expect(names).toContain("/trim");
    expect(names).toContain("/upload");
    expect(names).toContain("/download");
    expect(names).toContain("/delete");
    expect(names).toContain("/rename");
  });

  it("includes dynamic project commands when projects exist", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "my-video" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "demo" },
    });

    const result = await client.callTool({
      name: "commands",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const commands: Command[] = JSON.parse(content[0].text);
    const names = commands.map((c) => c.command);

    expect(names).toContain("/my-video");
    expect(names).toContain("/demo");

    const projCommands = commands.filter((c) => c.category === "project");
    expect(projCommands.length).toBe(2);
    for (const pc of projCommands) {
      expect(pc.icon).toBe("FolderOpen");
      expect(pc.chevron).toBe("down");
    }
  });
});

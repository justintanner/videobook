import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

interface Command {
  command: string;
  description: string;
  category: string;
  params: Array<{ name: string; type: string; required: boolean }>;
  mcpTool?: { tool: string; autoInject?: string[] };
  uiAction?: string;
  onMount?: string[];
}

describe("slash_commands tool", () => {
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

  it("returns all hardcoded commands", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const commands: Command[] = JSON.parse(content[0].text);

    // Check known hardcoded commands exist
    const commandNames = commands.map((c) => c.command);
    expect(commandNames).toContain("/generate");
    expect(commandNames).toContain("/trim");
    expect(commandNames).toContain("/trim-audio");
    expect(commandNames).toContain("/final");
    expect(commandNames).toContain("/download");
    expect(commandNames).toContain("/upload");
    expect(commandNames).toContain("/inbox");
    expect(commandNames).toContain("/copy");
    expect(commandNames).toContain("/folder");
    expect(commandNames).toContain("/duplicate");
    expect(commandNames).toContain("/history");
    expect(commandNames).toContain("/open");
    expect(commandNames).toContain("/delete");
    expect(commandNames).toContain("/rename");
    expect(commandNames).toContain("/assign");
    expect(commandNames).toContain("/unassign");
    expect(commandNames).toContain("/rewrite");
    expect(commandNames).toContain("/render");
    expect(commandNames).toContain("/vocals");
    expect(commandNames).toContain("/original");
    expect(commandNames).toContain("/landscape");
    expect(commandNames).toContain("/portrait");
    expect(commandNames).toContain("/info");
    expect(commandNames).toContain("/settings");
    expect(commandNames).toContain("/files");
  });

  it("includes dynamic project commands", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "alpha" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "beta" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const commandNames = commands.map((c) => c.command);
    expect(commandNames).toContain("/alpha");
    expect(commandNames).toContain("/beta");

    const alphaCmd = commands.find((c) => c.command === "/alpha")!;
    expect(alphaCmd.category).toBe("project");
    expect(alphaCmd.uiAction).toBe("switch_project");
  });

  it("every command has required fields", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    for (const cmd of commands) {
      expect(cmd.command).toBeTruthy();
      expect(cmd.command.startsWith("/")).toBe(true);
      expect(cmd.description).toBeTruthy();
      expect(["action", "project", "context_menu", "viewer"]).toContain(
        cmd.category,
      );
      expect(cmd.params).toBeDefined();
      expect(Array.isArray(cmd.params)).toBe(true);
    }
  });

  it("mcpTool references point to registered tools", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );

    // Get the list of registered tools
    const toolsResult = await client.listTools();
    const registeredToolNames = new Set(toolsResult.tools.map((t) => t.name));

    for (const cmd of commands) {
      if (cmd.mcpTool) {
        expect(
          registeredToolNames.has(cmd.mcpTool.tool),
          `Command ${cmd.command} references MCP tool "${cmd.mcpTool.tool}" which is not registered`,
        ).toBe(true);
      }
    }
  });

  it("every command has either mcpTool, uiAction, or falls through to chat", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );

    // Commands that fall through to chat (no mcpTool or uiAction)
    const chatFallbackCommands = commands.filter(
      (c) => !c.mcpTool && !c.uiAction,
    );
    // These should be known fallback commands
    const expectedFallbacks = ["/generate", "/trim", "/trim-audio", "/final"];
    for (const cmd of chatFallbackCommands) {
      expect(
        expectedFallbacks.includes(cmd.command),
        `Command ${cmd.command} has neither mcpTool nor uiAction — is this intentional?`,
      ).toBe(true);
    }
  });

  it("viewer commands have onMount=['viewer']", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );

    const viewerCommands = commands.filter((c) => c.category === "viewer");
    for (const cmd of viewerCommands) {
      expect(
        cmd.onMount,
        `Viewer command ${cmd.command} should have onMount`,
      ).toContain("viewer");
    }
  });

  it("returns empty project commands when no projects exist", async () => {
    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const projectCommands = commands.filter((c) => c.category === "project");
    expect(projectCommands).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createFs } from "videocity-engine";
import {
  adaptCommandArgs,
  COMMAND_ADAPTERS,
  filterCommandsByMountKeys,
  parseCommandArgs,
  type ServerCommand,
} from "../../../src/lib/command-registry.js";
import { commandsDef } from "./commands.js";
import { getVideoEditingToolDefs } from "./index.js";
import {
  COMMAND_ADAPTER_NAMES,
  VIDEO_EDITING_COMMANDS,
  VIDEO_EDITING_TOOL_CONTRACTS,
  expandCommandAliases,
} from "./video-editing-command-contract.js";
import type { ToolDef } from "./tool-def.js";

type TextContent = Array<{ type: string; text: string }>;

describe("video editing command contract", () => {
  let tempDir: string;
  let commands: ServerCommand[];
  let toolDefs: ToolDef[];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-command-contract-"));
    const fs = createFs({ projectsDir: tempDir });
    toolDefs = getVideoEditingToolDefs(fs);
    const result = await commandsDef(fs).handler({});
    commands = JSON.parse((result.content as TextContent)[0].text) as ServerCommand[];
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("classifies every registered video editing tool exactly once", () => {
    const registered = toolDefs.map((tool) => tool.name);
    const classified = VIDEO_EDITING_TOOL_CONTRACTS.map((contract) => contract.tool);
    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...registered].sort());
  });

  it("keeps server adapter identifiers synchronized with client implementations", () => {
    expect([...COMMAND_ADAPTER_NAMES].sort()).toEqual(Object.keys(COMMAND_ADAPTERS).sort());
  });

  it("maps every exposed editing contract to a deterministic canonical command", () => {
    for (const contract of VIDEO_EDITING_TOOL_CONTRACTS) {
      if (contract.exposure === "internal") {
        expect(commands.some((command) => command.mcpTool?.tool === contract.tool)).toBe(false);
        continue;
      }
      const command = commands.find((candidate) => (
        candidate.command === contract.command && candidate.deprecated === false
      ));
      expect(command, `${contract.tool} command`).toBeDefined();
      expect(command?.exposure).toBe(contract.exposure);
      if (contract.exposure === "direct") {
        expect(command?.mcpTool?.tool).toBe(contract.tool);
      }
    }
  });

  it("validates every direct command example against its target tool schema", () => {
    for (const contract of VIDEO_EDITING_TOOL_CONTRACTS) {
      if (contract.exposure !== "direct") continue;
      const command = commands.find((candidate) => (
        candidate.command === contract.command && candidate.deprecated === false
      ));
      expect(command?.example, `${contract.command} example`).toBeDefined();
      if (!command?.example || !command.mcpTool) continue;

      const [commandToken, ...tokens] = command.example.trim().split(/\s+/);
      expect(commandToken).toBe(command.command);
      const parsed: Record<string, unknown> = parseCommandArgs(tokens.join(" "), command.params);
      for (const key of command.mcpTool.autoInject ?? []) {
        if (key === "project_slug") parsed[key] = "test-project";
      }
      Object.assign(parsed, command.mcpTool.injectParams ?? {});
      const adapted = adaptCommandArgs(command.mcpTool.adapter, command.mcpTool.tool, parsed);
      const target = toolDefs.find((tool) => tool.name === command.mcpTool?.tool);
      expect(target, `${command.command} target`).toBeDefined();
      if (!target) continue;

      const validation = z.object(target.schema).safeParse(adapted);
      const issues = validation.success ? [] : validation.error.issues;
      expect(validation.success, `${command.command}: ${JSON.stringify(issues)}`).toBe(true);
    }
  });

  it("generates unique deprecated aliases and hides them from picker surfaces", () => {
    const expanded = expandCommandAliases(VIDEO_EDITING_COMMANDS);
    expect(new Set(expanded.map((command) => command.command)).size).toBe(expanded.length);
    for (const command of VIDEO_EDITING_COMMANDS) {
      const canonical = expanded.find((candidate) => candidate.command === command.command);
      expect(canonical?.canonical).toBe(command.command);
      expect(canonical?.deprecated).toBe(false);
      for (const alias of command.aliases ?? []) {
        const legacy = expanded.find((candidate) => candidate.command === alias);
        expect(legacy?.canonical).toBe(command.command);
        expect(legacy?.deprecated).toBe(true);
      }
    }
    const pickerCommands = filterCommandsByMountKeys(commands, new Set(["viewer"]));
    expect(pickerCommands.some((command) => command.deprecated)).toBe(false);
  });

  it("keeps runtime defaults synchronized with command help", () => {
    const split = VIDEO_EDITING_COMMANDS.find((command) => command.command === "/split-chunks");
    expect(split?.params.find((param) => param.name === "target_secs")?.description).toContain("default 7");
    const render = toolDefs.find((tool) => tool.name === "render_video");
    expect(render?.schema.orientation.description).toContain("omit to render all three orientations");
  });
});

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
  mcpTool?: {
    tool: string;
    autoInject?: string[];
    injectParams?: Record<string, string | number | boolean>;
  };
  uiAction?: string;
  onMount?: string[];
}

describe("slash_commands tool", () => {
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
    expect(commandNames).toContain("/video");
    expect(commandNames).toContain("/image");
    expect(commandNames).toContain("/generate");
    expect(commandNames).toContain("/trim");
    expect(commandNames).toContain("/trim-audio");
    expect(commandNames).toContain("/final");
    expect(commandNames).toContain("/download");
    expect(commandNames).toContain("/upload");
    expect(commandNames).toContain("/inbox");
    expect(commandNames).toContain("/copy");
    expect(commandNames).toContain("/folder");
    expect(commandNames).toContain("/archive");
    expect(commandNames).toContain("/duplicate");
    expect(commandNames).toContain("/history");
    expect(commandNames).toContain("/open");
    expect(commandNames).toContain("/delete");
    expect(commandNames).toContain("/rename");
    expect(commandNames).toContain("/assign");
    expect(commandNames).toContain("/unassign");
    expect(commandNames).toContain("/insert-slot");
    expect(commandNames).toContain("/rewrite");
    expect(commandNames).toContain("/rewrite-script");
    expect(commandNames).toContain("/render");
    expect(commandNames).toContain("/clean-audio");
    expect(commandNames).toContain("/vocals");
    expect(commandNames).toContain("/original");
    expect(commandNames).toContain("/landscape");
    expect(commandNames).toContain("/portrait");
    expect(commandNames).toContain("/info");
    expect(commandNames).toContain("/settings");
    expect(commandNames).toContain("/files");
    expect(commandNames).toContain("/notebook");
    expect(commandNames).not.toContain("/plan");
    expect(commandNames).toContain("/projects");
    expect(commandNames).toContain("/project-new");
    expect(commandNames).toContain("/project-rename");
    expect(commandNames).toContain("/project-delete");
    expect(commandNames).toContain("/close");
    expect(commandNames).toContain("/collapse");
    expect(commandNames).toContain("/expand");
    expect(commandNames).toContain("/sort");
    expect(commandNames).toContain("/keys");
    expect(commandNames).toContain("/archive-browse");
    expect(commandNames).toContain("/audio-add");
    expect(commandNames).toContain("/audio-mix");
    expect(commandNames).toContain("/extend-audio");
    expect(commandNames).toContain("/remove-sound");
    expect(commandNames).toContain("/audio-move");
    expect(commandNames).toContain("/audio-remove");
    expect(commandNames).toContain("/audio-set");
    expect(commandNames).toContain("/reverse");
    expect(commandNames).toContain("/speed");
    expect(commandNames).toContain("/timewarp");
    expect(commandNames).toContain("/sync-audio");
    expect(commandNames).toContain("/split");
    expect(commandNames).toContain("/export-to");
    expect(commandNames).toContain("/skeleton");
    expect(commandNames).toContain("/archive-restore");
    expect(commandNames).toContain("/rewind");
    expect(commandNames).toContain("/clear-failed");
    expect(commandNames).toContain("/voices");
    expect(commandNames).toContain("/say");
    expect(commandNames).toContain("/connect-x");
    expect(commandNames).toContain("/play");
    expect(commandNames).toContain("/qart");
    expect(commandNames).toContain("/apply-sfx");
    expect(commandNames).toContain("/inject-first-frame");
    expect(commandNames).toContain("/scene-concat");

    const timewarp = commands.find((c) => c.command === "/timewarp")!;
    expect(timewarp.mcpTool?.tool).toBe("timewarp_video");
    expect(timewarp.mcpTool?.autoInject).toContain("project_slug");
    expect(timewarp.params.map((p) => p.name)).toEqual(["asset_id", "range", "factor"]);

    const insertSlot = commands.find((c) => c.command === "/insert-slot")!;
    expect(insertSlot.mcpTool?.tool).toBe("insert_timeline_slot");
    expect(insertSlot.mcpTool?.autoInject).toContain("project_slug");
    expect(insertSlot.params.map((p) => p.name)).toEqual(["slot", "position"]);

    const syncAudio = commands.find((c) => c.command === "/sync-audio")!;
    expect(syncAudio.mcpTool?.tool).toBe("sync_video_to_audio");
    expect(syncAudio.mcpTool?.autoInject).toContain("project_slug");
    expect(syncAudio.params.map((p) => p.name)).toEqual(["asset_id", "mappings"]);

    const qart = commands.find((c) => c.command === "/qart")!;
    expect(qart.mcpTool?.tool).toBe("create_qart");
    expect(qart.mcpTool?.autoInject).toContain("project_slug");
    expect(qart.params.map((p) => p.name)).toEqual(["image_slug", "value"]);

    expect(commandNames).toContain("/qrbtf");

    const qrbtf = commands.find((c) => c.command === "/qrbtf")!;
    expect(qrbtf.mcpTool?.tool).toBe("create_qrbtf");
    expect(qrbtf.mcpTool?.autoInject).toContain("project_slug");
    expect(qrbtf.params.map((p) => p.name)).toEqual(["value", "style"]);

    expect(commandNames).not.toContain("/qr-outro");
    expect(commandNames).toContain("/outroqr");
    const qrOutro = commands.find((c) => c.command === "/outroqr")!;
    expect(qrOutro.mcpTool?.tool).toBe("create_qr_outro");
    expect(qrOutro.mcpTool?.autoInject).toContain("project_slug");
    expect(qrOutro.mcpTool?.injectParams).toEqual({
      duration_seconds: 10,
      include_audio: true,
    });
    expect(qrOutro.description).toContain("bundled impact sound");
    expect(qrOutro.params.map((p) => p.name)).toEqual(["inputs"]);
    expect(qrOutro.params[0].type).toBe("string[]");

    const cleanAudio = commands.find((c) => c.command === "/clean-audio")!;
    expect(cleanAudio.mcpTool?.tool).toBe("clean_video_audio");
    expect(cleanAudio.mcpTool?.autoInject).toContain("project_slug");
    expect(cleanAudio.params.map((p) => p.name)).toEqual([
      "asset_id",
      "add_light_music",
    ]);

    const applySfx = commands.find((c) => c.command === "/apply-sfx")!;
    expect(applySfx.mcpTool?.tool).toBe("apply_sfx");
    expect(applySfx.mcpTool?.autoInject).toContain("project_slug");
    expect(applySfx.params.map((p) => p.name)).toEqual([
      "asset_id",
      "timestamp",
      "type",
      "description",
    ]);

    const audioMix = commands.find((c) => c.command === "/audio-mix")!;
    expect(audioMix.mcpTool?.tool).toBe("audio_mix");
    expect(audioMix.mcpTool?.autoInject).toContain("project_slug");
    expect(audioMix.params.map((p) => p.name)).toEqual([
      "target_asset_id",
      "layer_asset_id",
      "volume",
    ]);

    const splice = commands.find((c) => c.command === "/splice")!;
    expect(splice.mcpTool?.tool).toBe("splice_video");
    expect(splice.mcpTool?.autoInject).toContain("project_slug");
    expect(splice.params.map((p) => p.name)).toEqual([
      "first_asset_id",
      "second_asset_id",
      "overlap",
    ]);
    expect(splice.params[2]).toMatchObject({ type: "number", required: true });

    const sceneConcat = commands.find((c) => c.command === "/scene-concat")!;
    expect(sceneConcat.mcpTool?.tool).toBe("smooth_scene_concat");
    expect(sceneConcat.mcpTool?.autoInject).toContain("project_slug");
    expect(sceneConcat.params.map((p) => p.name)).toEqual([
      "first_asset_id",
      "second_asset_id",
      "transition_seconds",
    ]);
    expect(sceneConcat.params[2]).toMatchObject({ type: "number", required: false });

    const extendAudio = commands.find((c) => c.command === "/extend-audio")!;
    expect(extendAudio.mcpTool?.tool).toBe("extend_audio");
    expect(extendAudio.mcpTool?.autoInject).toContain("project_slug");
    expect(extendAudio.params.map((p) => p.name)).toEqual([
      "asset_id",
      "target_duration_seconds",
      "continuation_prompt",
    ]);

    const removeSound = commands.find((c) => c.command === "/remove-sound")!;
    expect(removeSound.mcpTool?.tool).toBe("remove_sound");
    expect(removeSound.mcpTool?.autoInject).toContain("project_slug");
    expect(removeSound.params.map((p) => p.name)).toEqual([
      "asset_id",
      "sound",
    ]);

    const injectFirstFrame = commands.find((c) => c.command === "/inject-first-frame")!;
    expect(injectFirstFrame.mcpTool?.tool).toBe("inject_first_frame");
    expect(injectFirstFrame.mcpTool?.autoInject).toContain("project_slug");
    expect(injectFirstFrame.params.map((p) => p.name)).toEqual([
      "target_asset_id",
      "image_asset_id",
      "orientation",
    ]);

    const notebook = commands.find((c) => c.command === "/notebook")!;
    expect(notebook.uiAction).toBe("open_notebook");
    expect(notebook.params).toEqual([
      { name: "name", type: "string", required: false, description: "Notebook name. Omit to open the current/default notebook, or create 'scratch' if none exist." },
    ]);
    expect(notebook.category).toBe("action");

    const archive = commands.find((c) => c.command === "/archive")!;
    expect(archive.category).toBe("context_menu");
    expect(archive.mcpTool?.tool).toBe("archive_clip");
    expect(archive.mcpTool?.autoInject).toContain("project_slug");
  });

  it("does not return duplicate command names", async () => {
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
    const names = commands.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
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
    const expectedFallbacks = ["/trim", "/trim-audio"];
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
      const hasViewerOrGen = cmd.onMount?.includes("viewer") || cmd.onMount?.includes("gen");
      expect(
        hasViewerOrGen,
        `Viewer command ${cmd.command} should have onMount containing 'viewer' or 'gen'`,
      ).toBe(true);
    }
  });

  it("returns no switch-project commands when no projects exist", async () => {
    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const switchCommands = commands.filter((c) => c.uiAction === "switch_project");
    expect(switchCommands).toHaveLength(0);
  });

  it("skips dynamic project commands that collide with hardcoded names", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "play" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const playCommands = commands.filter((c) => c.command === "/play");
    expect(playCommands).toHaveLength(1);
    expect(playCommands[0].uiAction).toBe("open_slot_player");
  });
});

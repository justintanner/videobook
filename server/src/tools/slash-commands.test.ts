import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";
import {
  COMMAND_ADAPTERS,
  adaptCommandArgs,
  parseCommandArgs,
} from "../../../src/lib/command-registry.js";
import { BookManager } from "../book-manager.js";
import { commandsDef } from "./commands.js";

type TextContent = Array<{ type: string; text: string }>;

interface Command {
  command: string;
  description: string;
  category: string;
  canonical?: string;
  params: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "string[]";
    required: boolean;
    description: string;
  }>;
  mcpTool?: {
    tool: string;
    adapter?: string;
    autoInject?: string[];
    injectParams?: Record<string, string | number | boolean>;
  };
  uiAction?: string;
  aliases?: string[];
  exposure?: string;
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
      arguments: { book_id: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const commands: Command[] = JSON.parse(content[0].text);

    const commandNames = commands.map((c) => c.command);
    expect(commandNames).not.toContain("/trim");
    expect(commandNames).toContain("/trim-video");
    expect(commandNames).toContain("/trim-audio");
    expect(commandNames).toContain("/split-chunks");
    expect(commandNames).toContain("/overlay");
    expect(commandNames).toContain("/apply-cuts");
    expect(commandNames).toContain("/extract-frame");
    expect(commandNames).toContain("/transcript");
    expect(commandNames).toContain("/translate-subs");
    expect(commandNames).toContain("/audio-settings");
    expect(commandNames).toContain("/final");
    expect(commandNames).toContain("/download");
    expect(commandNames).toContain("/upload");
    expect(commandNames).toContain("/inbox");
    expect(commandNames).toContain("/copy");
    expect(commandNames).toContain("/folder");
    expect(commandNames).toContain("/archive");
    expect(commandNames).toContain("/make-cover-song");
    expect(commandNames).toContain("/duplicate");
    expect(commandNames).toContain("/group-images");
    expect(commandNames).toContain("/history");
    expect(commandNames).toContain("/open");
    expect(commandNames).toContain("/delete");
    expect(commandNames).toContain("/rename");
    expect(commandNames).toContain("/assign");
    expect(commandNames).toContain("/unassign");
    expect(commandNames).toContain("/insert-slot");
    expect(commandNames).toContain("/remove-slot");
    expect(commandNames).toContain("/rewrite");
    expect(commandNames).toContain("/rewrite-script");
    expect(commandNames).not.toContain("/render");
    expect(commandNames).toContain("/render-video");
    expect(commandNames).toContain("/clean-audio");
    expect(commandNames).toContain("/vocals");
    expect(commandNames).toContain("/original");
    expect(commandNames).toContain("/landscape");
    expect(commandNames).toContain("/portrait");
    expect(commandNames).toContain("/info");
    expect(commandNames).toContain("/settings");
    expect(commandNames).toContain("/files");
    expect(commandNames).toContain("/notebook");
    expect(commandNames).toContain("/music-video");
    expect(commandNames).toContain("/notebooks");
    expect(commandNames).toContain("/save");
    expect(commandNames).toContain("/run");
    expect(commandNames).toContain("/prompt-new");
    expect(commandNames).toContain("/character-new");
    expect(commandNames).toContain("/scene-new");
    expect(commandNames).toContain("/entities");
    expect(commandNames).toContain("/jobs");
    expect(commandNames).toContain("/revisions");
    expect(commandNames).toContain("/storage");
    expect(commandNames).toContain("/sync");
    expect(commandNames).toContain("/providers");
    expect(commandNames).toContain("/diagnostics");
    expect(commandNames).not.toContain("/plan");
    expect(commandNames).toContain("/books");
    expect(commandNames).not.toContain("/projects");
    expect(commandNames).not.toContain("/project-new");
    expect(commandNames).not.toContain("/project-rename");
    expect(commandNames).not.toContain("/project-delete");
    expect(commandNames).toContain("/close");
    expect(commandNames).toContain("/collapse");
    expect(commandNames).toContain("/expand");
    expect(commands.find((command) => command.command === "/expand")?.description)
      .toMatch(/chat controls \(right\)/u);
    expect(commands.find((command) => command.command === "/collapse")?.description)
      .toMatch(/chat controls \(right\)/u);
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
    expect(commandNames).toContain("/split-clip");
    expect(commandNames).toContain("/export-to");
    expect(commandNames).toContain("/skeleton");
    expect(commandNames).toContain("/archive-restore");
    expect(commandNames).toContain("/rewind");
    expect(commandNames).toContain("/clear-failed");
    expect(commandNames).toContain("/voices");
    expect(commandNames).toContain("/say");
    expect(commandNames).toContain("/speak");
    const speak = commands.find((c) => c.command === "/speak")!;
    expect(speak.uiAction).toBe("speak_preview");
    expect(speak.category).toBe("action");
    const voices = commands.find((c) => c.command === "/voices")!;
    expect(voices.uiAction).toBe("speak_preview");
    expect(voices.description).toMatch(/speak preview/i);
    const say = commands.find((c) => c.command === "/say")!;
    expect(say.mcpTool?.tool).toBe("generate_elevenlabs_text_to_audio");
    expect(commandNames).toContain("/connect-x");
    expect(commandNames).toContain("/play");
    expect(commandNames).toContain("/qart");
    expect(commandNames).toContain("/apply-sfx");
    expect(commandNames).toContain("/inject-first-frame");
    expect(commandNames).toContain("/scene-concat");

    const timewarp = commands.find((c) => c.command === "/timewarp")!;
    expect(timewarp.mcpTool?.tool).toBe("timewarp_video");
    expect(timewarp.mcpTool?.autoInject).toContain("book_id");
    expect(timewarp.params.map((p) => p.name)).toEqual(["asset_id", "range", "factor"]);

    const insertSlot = commands.find((c) => c.command === "/insert-slot")!;
    expect(insertSlot.mcpTool?.tool).toBe("insert_timeline_slot");
    expect(insertSlot.mcpTool?.autoInject).toContain("book_id");
    expect(insertSlot.params.map((p) => p.name)).toEqual(["slot", "position"]);

    const removeSlot = commands.find((c) => c.command === "/remove-slot")!;
    expect(removeSlot.mcpTool?.tool).toBe("remove_timeline_slot");
    expect(removeSlot.mcpTool?.autoInject).toContain("book_id");
    expect(removeSlot.params.map((p) => p.name)).toEqual(["slot"]);

    const syncAudio = commands.find((c) => c.command === "/sync-audio")!;
    expect(syncAudio.mcpTool?.tool).toBe("sync_video_to_audio");
    expect(syncAudio.mcpTool?.autoInject).toContain("book_id");
    expect(syncAudio.params.map((p) => p.name)).toEqual(["asset_id", "mappings"]);

    const qart = commands.find((c) => c.command === "/qart")!;
    expect(qart.mcpTool?.tool).toBe("create_qart");
    expect(qart.mcpTool?.autoInject).toContain("book_id");
    expect(qart.params.map((p) => p.name)).toEqual(["image_ref", "value"]);

    expect(commandNames).toContain("/qrbtf");

    const qrbtf = commands.find((c) => c.command === "/qrbtf")!;
    expect(qrbtf.mcpTool?.tool).toBe("create_qrbtf");
    expect(qrbtf.mcpTool?.autoInject).toContain("book_id");
    expect(qrbtf.params.map((p) => p.name)).toEqual(["value", "style"]);

    expect(commandNames).not.toContain("/qr-outro");
    expect(commandNames).toContain("/outroqr");
    const qrOutro = commands.find((c) => c.command === "/outroqr")!;
    expect(qrOutro.mcpTool?.tool).toBe("create_qr_outro");
    expect(qrOutro.mcpTool?.autoInject).toContain("book_id");
    expect(qrOutro.mcpTool?.injectParams).toEqual({
      duration_seconds: 10,
      include_audio: true,
    });
    expect(qrOutro.description).toContain("bundled impact sound");
    expect(qrOutro.params.map((p) => p.name)).toEqual(["inputs"]);
    expect(qrOutro.params[0].type).toBe("string[]");

    const cleanAudio = commands.find((c) => c.command === "/clean-audio")!;
    expect(cleanAudio.mcpTool?.tool).toBe("clean_video_audio");
    expect(cleanAudio.mcpTool?.autoInject).toContain("book_id");
    expect(cleanAudio.params.map((p) => p.name)).toEqual([
      "asset_id",
      "add_light_music",
    ]);

    const applySfx = commands.find((c) => c.command === "/apply-sfx")!;
    expect(applySfx.mcpTool?.tool).toBe("apply_sfx");
    expect(applySfx.mcpTool?.autoInject).toContain("book_id");
    expect(applySfx.params.map((p) => p.name)).toEqual([
      "asset_id",
      "timestamp",
      "type",
      "description",
    ]);

    const audioMix = commands.find((c) => c.command === "/audio-mix")!;
    expect(audioMix.mcpTool?.tool).toBe("audio_mix");
    expect(audioMix.mcpTool?.autoInject).toContain("book_id");
    expect(audioMix.params.map((p) => p.name)).toEqual([
      "target_asset_id",
      "layer_asset_id",
      "volume",
    ]);

    const splice = commands.find((c) => c.command === "/splice")!;
    expect(splice.mcpTool?.tool).toBe("splice_video");
    expect(splice.mcpTool?.autoInject).toContain("book_id");
    expect(splice.params.map((p) => p.name)).toEqual([
      "first_asset_id",
      "second_asset_id",
      "overlap",
    ]);
    expect(splice.params[2]).toMatchObject({ type: "number", required: true });

    const sceneConcat = commands.find((c) => c.command === "/scene-concat")!;
    expect(sceneConcat.mcpTool?.tool).toBe("smooth_scene_concat");
    expect(sceneConcat.mcpTool?.autoInject).toContain("book_id");
    expect(sceneConcat.params.map((p) => p.name)).toEqual([
      "first_asset_id",
      "second_asset_id",
      "transition_seconds",
    ]);
    expect(sceneConcat.params[2]).toMatchObject({ type: "number", required: false });

    const extendAudio = commands.find((c) => c.command === "/extend-audio")!;
    expect(extendAudio.mcpTool?.tool).toBe("extend_audio_asset");
    expect(extendAudio.mcpTool?.autoInject).toContain("book_id");
    expect(extendAudio.params.map((p) => p.name)).toEqual([
      "asset_id",
      "target_duration_seconds",
      "continuation_prompt",
    ]);

    const makeCoverSong = commands.find((c) => c.command === "/make-cover-song")!;
    expect(makeCoverSong.mcpTool?.tool).toBe("make_cover_song");
    expect(makeCoverSong.mcpTool?.autoInject).toContain("book_id");
    expect(makeCoverSong.aliases).toContain("/replicate-song");
    expect(makeCoverSong.params).toMatchObject([
      { name: "asset_id", type: "string", required: true },
      { name: "direction", type: "string", required: false },
    ]);

    const removeSound = commands.find((c) => c.command === "/remove-sound")!;
    expect(removeSound.mcpTool?.tool).toBe("remove_sound");
    expect(removeSound.mcpTool?.autoInject).toContain("book_id");
    expect(removeSound.params.map((p) => p.name)).toEqual([
      "asset_id",
      "sound",
    ]);

    const injectFirstFrame = commands.find((c) => c.command === "/inject-first-frame")!;
    expect(injectFirstFrame.mcpTool?.tool).toBe("inject_first_frame");
    expect(injectFirstFrame.mcpTool?.autoInject).toContain("book_id");
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

    const musicVideo = commands.find((c) => c.command === "/music-video")!;
    expect(musicVideo.uiAction).toBe("open_music_video");
    expect(musicVideo.exposure).toBe("ui");
    expect(musicVideo.params).toEqual([
      {
        name: "audio_ref",
        type: "string",
        required: true,
        description: "Ready audio artifact or notebook address used as the master soundtrack",
      },
    ]);

    const save = commands.find((c) => c.command === "/save")!;
    expect(save.uiAction).toBe("save_notebook");

    const run = commands.find((c) => c.command === "/run")!;
    expect(run.uiAction).toBe("run_notebook");

    expect(commands.find((c) => c.command === "/prompt-new")?.mcpTool?.tool)
      .toBe("create_prompt_entity");
    expect(commands.find((c) => c.command === "/character-new")?.mcpTool?.tool)
      .toBe("create_character_entity");
    expect(commands.find((c) => c.command === "/scene-new")?.mcpTool?.tool)
      .toBe("create_scene_entity");

    const archive = commands.find((c) => c.command === "/archive")!;
    expect(archive.category).toBe("context_menu");
    expect(archive.mcpTool?.tool).toBe("archive_clip");
    expect(archive.mcpTool?.autoInject).toContain("book_id");

    expect(commands.find((c) => c.command === "/trim-video")?.aliases).toContain("/trim");
    expect(commands.find((c) => c.command === "/render-video")?.aliases).toContain("/render");
    expect(commands.find((c) => c.command === "/activity")?.aliases).toContain("/status");
    expect(commands.find((c) => c.command === "/copy-media")?.aliases).toContain("/copy-video");
  });

  it("adapts duplicate destinations while preserving optional names", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });
    const command = (JSON.parse(
      (result.content as TextContent)[0].text,
    ) as Command[]).find((candidate) => candidate.command === "/duplicate");
    expect(command).toBeDefined();
    if (!command?.mcpTool) return;
    const parsed = parseCommandArgs("@a1 @b1 copied scene", command.params);
    expect(adaptCommandArgs(
      command.mcpTool.adapter,
      parsed,
    )).toEqual({
      asset_id: "a1",
      destination: "b1",
      new_name: "copied scene",
    });
    expect(command.mcpTool.autoInject).toEqual(["book_id", "notebook_id"]);
  });

  it("keeps a duplicate's multi-word free-text name together", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });
    const command = (JSON.parse(
      (result.content as TextContent)[0].text,
    ) as Command[]).find((candidate) => candidate.command === "/duplicate");
    expect(command).toBeDefined();
    if (!command?.mcpTool) return;

    const parsed = parseCommandArgs("@hero-intro my cool copy", command.params);
    expect(parsed).toEqual({
      asset_id: "hero-intro",
      new_name: "my cool copy",
    });
    expect(adaptCommandArgs(command.mcpTool.adapter, parsed)).toEqual(parsed);
  });

  it("does not return duplicate command names", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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
    const books = new BookManager({
      libraryDir: join(tempDir, "books"),
      objectPrefix: "test-objects",
      catalogBackupName: "backup",
    });
    await books.ready();
    await books.create("alpha");
    await books.create("beta");
    const result = await commandsDef(books).handler({});

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const commandNames = commands.map((c) => c.command);
    expect(commandNames).toContain("/alpha");
    expect(commandNames).toContain("/beta");

    const alphaCmd = commands.find((c) => c.command === "/alpha")!;
    expect(alphaCmd.category).toBe("project");
    expect(alphaCmd.uiAction).toBe("switch_book");
    await books.close();
  });

  it("every command has required fields", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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
      arguments: { book_id: "test-proj" },
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
        if (cmd.mcpTool.adapter) {
          expect(
            cmd.mcpTool.adapter in COMMAND_ADAPTERS,
            `Command ${cmd.command} specifies adapter "${cmd.mcpTool.adapter}" which is not in COMMAND_ADAPTERS`,
          ).toBe(true);
        }
      }
    }
  });

  it("canonical fields reference valid slash commands", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const registeredNames = new Set(commands.map((c) => c.command));

    for (const cmd of commands) {
      if (cmd.canonical) {
        expect(cmd.canonical.startsWith("/")).toBe(true);
        expect(
          registeredNames.has(cmd.canonical),
          `Command ${cmd.command} references canonical command "${cmd.canonical}" which is not registered`,
        ).toBe(true);
      }
    }
  });

  it("every command has either mcpTool, uiAction, or falls through to chat", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });

    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );

    // All known editing slash commands now have explicit mcpTool or uiAction
    const chatFallbackCommands = commands.filter(
      (c) => !c.mcpTool && !c.uiAction && c.exposure !== "composite",
    );
    expect(chatFallbackCommands).toHaveLength(0);
  });

  it("returns no switch-book commands when no books exist", async () => {
    const result = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const switchCommands = commands.filter((c) => c.uiAction === "switch_book");
    expect(switchCommands).toHaveLength(0);
  });

  it("skips dynamic project commands that collide with hardcoded names", async () => {
    const books = new BookManager({
      libraryDir: join(tempDir, "books"),
      objectPrefix: "test-objects",
      catalogBackupName: "backup",
    });
    await books.ready();
    await books.create("play");
    const result = await commandsDef(books).handler({});

    const commands: Command[] = JSON.parse(
      (result.content as TextContent)[0].text,
    );
    const playCommands = commands.filter((c) => c.command === "/play");
    expect(playCommands).toHaveLength(1);
    expect(playCommands[0].uiAction).toBe("open_slot_player");
    await books.close();
  });
});

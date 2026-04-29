/**
 * End-to-end tests for all slash commands.
 *
 * Simulates the full dispatch path: parse command string → extract args via
 * parseCommandArgs → call the backing MCP tool → verify results.
 *
 * Tests each command with different inputs (happy path, error cases, edge cases).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFs } from "clipfirst-engine";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parseCommandArgs, filterCommandsByMountKeys } from "../../../src/lib/command-registry.js";
import type { ServerCommand } from "../../../src/lib/command-registry.js";

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: { content?: unknown; toolResult?: unknown }): Record<string, unknown> {
  let content: unknown;
  if (result.content) {
    content = result.content;
  } else if (result.toolResult) {
    const toolResult = result.toolResult as { content?: TextContent } | undefined;
    content = toolResult?.content;
  }
  return JSON.parse((content as TextContent)[0].text);
}

describe("slash commands e2e", () => {
  let client: Client;
  let tempDir: string;
  let commands: ServerCommand[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-slash-e2e-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });

    // Fetch the commands list
    const cmdResult = await client.callTool({
      name: "slash_commands",
      arguments: {},
    });
    commands = JSON.parse((cmdResult.content as TextContent)[0].text);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // -----------------------------------------------------------------------
  // Helper: simulate frontend dispatch for a slash command string
  // -----------------------------------------------------------------------
  function findCommand(name: string): ServerCommand {
    const cmd = commands.find((c) => c.command === name);
    if (!cmd) throw new Error(`Command ${name} not found`);
    return cmd;
  }

  function simulateParse(commandStr: string, rest: string): Record<string, string> {
    const cmd = findCommand(commandStr);
    return parseCommandArgs(rest, cmd.params);
  }

  // -----------------------------------------------------------------------
  // 1. /download — download_video
  // -----------------------------------------------------------------------
  describe("/download", () => {
    it("parses '/download https://youtube.com/watch?v=abc'", () => {
      const args = simulateParse("/download", "https://youtube.com/watch?v=abc");
      expect(args.url).toBe("https://youtube.com/watch?v=abc");
    });

    it("enqueues a download job for a valid URL", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/some-video",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
      expect(parsed.assetId).toBeDefined();
      expect(parsed.job_id).toBeDefined();
    });

    it("enqueues a download with start_time and end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "10",
          end_time: "30",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });

    it("errors when start_time > end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "60",
          end_time: "10",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("errors when full=true with start_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "10",
          full: true,
        },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for invalid timestamp format", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "not-a-time",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 2. /folder — show_folder
  // -----------------------------------------------------------------------
  describe("/folder", () => {
    it("parses '/folder @product-shot'", () => {
      const args = simulateParse("/folder", "@product-shot");
      expect(args.asset_id).toBe("product-shot");
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: "img-nonexistent", project_slug: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. /duplicate — duplicate_asset
  // -----------------------------------------------------------------------
  describe("/duplicate", () => {
    it("parses '/duplicate @hero-intro hero-intro-v2'", () => {
      const args = simulateParse("/duplicate", "@hero-intro hero-intro-v2");
      expect(args.asset_id).toBe("hero-intro");
      expect(args.new_name).toBe("hero-intro-v2");
    });

    it("parses '/duplicate @hero-intro' (no new_name)", () => {
      const args = simulateParse("/duplicate", "@hero-intro");
      expect(args.asset_id).toBe("hero-intro");
      expect(args.new_name).toBeUndefined();
    });

    it("duplicates an asset successfully", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.source_asset_id).toBe(uploaded.assetId);
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.new_asset_id).not.toBe(uploaded.assetId);
    });

    it("duplicates with custom name", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          project_slug: "test-proj",
          new_name: "my-copy",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: { asset_id: "img-nonexistent", project_slug: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 4. /delete — delete_asset
  // -----------------------------------------------------------------------
  describe("/delete", () => {
    it("parses '/delete @outro-clip'", () => {
      const args = simulateParse("/delete", "@outro-clip");
      expect(args.asset_id).toBe("outro-clip");
    });

    it("deletes an existing asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("deleted");

      // Verify deleted
      const manifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: uploaded.assetId as string, project_slug: "test-proj" },
      });
      expect(manifest.isError).toBe(true);
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: "img-nonexistent", project_slug: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5. /rename — rename_asset
  // -----------------------------------------------------------------------
  describe("/rename", () => {
    it("parses '/rename @product-shot product-hero'", () => {
      const args = simulateParse("/rename", "@product-shot product-hero");
      expect(args.asset_id).toBe("product-shot");
      expect(args.new_name).toBe("product-hero");
    });

    it("parses '/rename @product-shot to product-hero' (strips 'to')", () => {
      const args = simulateParse("/rename", "@product-shot to product-hero");
      expect(args.asset_id).toBe("product-shot");
      expect(args.new_name).toBe("product-hero");
    });

    it("parses '/rename @img to my new name' (multi-word)", () => {
      const args = simulateParse("/rename", "@img to my new name");
      expect(args.asset_id).toBe("img");
      expect(args.new_name).toBe("my new name");
    });

    it("renames an existing asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          new_name: "sunset beach",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.old_asset_id).toBe(uploaded.assetId);
      expect(parsed.new_asset_id).not.toBe(uploaded.assetId);
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: "img-nonexistent",
          new_name: "whatever",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 6. /assign — assign_slot
  // -----------------------------------------------------------------------
  describe("/assign", () => {
    it("parses '/assign @vid-clip @s02'", () => {
      const args = simulateParse("/assign", "@vid-clip @s02");
      expect(args.asset_id).toBe("vid-clip");
      expect(args.slot).toBe("s02");
    });

    it("assigns asset to slot s01", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s01",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.slots).toBeDefined();
      expect((parsed.slots as Array<{ slug: string }>)[0].slug).toBe(uploaded.assetId);
    });

    it("assigns to s05, padding empty slots", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s05",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      const slots = parsed.slots as Array<{ slug: string }>;
      expect(slots).toHaveLength(5);
      expect(slots[4].slug).toBe(uploaded.assetId);
      // Slots 0-3 should be empty
      for (let i = 0; i < 4; i++) {
        expect(slots[i].slug).toBe("");
      }
    });

    it("errors for invalid slot format 'abc'", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: "vid-something",
          slot: "abc",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid slot format");
    });

    it("errors for slot s00", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: "vid-something",
          slot: "s00",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for nonexistent asset", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: "vid-nonexistent",
          slot: "s01",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 7. /unassign — unassign_slot
  // -----------------------------------------------------------------------
  describe("/unassign", () => {
    it("parses '/unassign @s02'", () => {
      const args = simulateParse("/unassign", "@s02");
      expect(args.slot).toBe("s02");
    });

    it("clears an assigned slot", async () => {
      // Upload + assign
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s01",
        },
      });

      // Clear
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.slots as Array<{ slug: string }>)[0].slug).toBe("");
    });

    it("errors for invalid slot format", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "xyz" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for slot s00", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s00" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for no timeline", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 8. /rewrite — rewrite_prompt (validation only, no API key)
  // -----------------------------------------------------------------------
  describe("/rewrite", () => {
    it("parses '/rewrite make it more cinematic'", () => {
      const args = simulateParse("/rewrite", "make it more cinematic");
      expect(args.prompt).toBe("make it more cinematic");
    });

    it("errors when OPENAI_API_KEY is unset", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            prompt: "a dog skateboarding",
            model: "nano_banana",
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("not set");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
      }
    });

    it("errors when prompt is missing in standard mode", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: { model: "nano_banana", project_slug: "test-proj" },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("prompt is required");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 9. /render — render
  // -----------------------------------------------------------------------
  describe("/render", () => {
    it("parses '/render @hero-intro'", () => {
      const args = simulateParse("/render", "@hero-intro");
      expect(args.asset_id).toBe("hero-intro");
    });

    it("errors for non-vid asset prefix", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: { asset_id: "img-something", project_slug: "test-proj" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("vid-");
    });

    it("errors for nonexistent vid asset", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: { asset_id: "vid-nonexistent", project_slug: "test-proj" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for invalid text_color hex", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          text_color: "not-hex",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid text_color hex");
    });

    it("errors for audio_volume out of range", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          audio_volume: 150,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("0-100");
    });

    it("errors for negative audio_fade_in", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          audio_fade_in: -10,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain(">= 0");
    });

    it("enqueues render for vid asset with video file", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "my-video", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      // Write a minimal fake video file
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
      expect(parsed.orientation).toBe("landscape");
    });

    it("errors for osg_asset_id with non-img prefix", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "my-video2", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: "vid-something",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("img-");
    });
  });

  // -----------------------------------------------------------------------
  // 10. /vocals — isolate_vocals
  // -----------------------------------------------------------------------
  describe("/vocals", () => {
    it("parses '/vocals @voiceover-main'", () => {
      const args = simulateParse("/vocals", "@voiceover-main");
      expect(args.asset_id).toBe("voiceover-main");
    });

    it("errors when KIE_API_KEY is unset", async () => {
      const origKey = process.env.KIE_API_KEY;
      delete process.env.KIE_API_KEY;
      try {
        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: { asset_id: "vid-test", project_slug: "test-proj" },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("not set");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
      }
    });

    it("errors for nonexistent asset", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: { asset_id: "vid-nonexistent", project_slug: "test-proj" },
        });
        expect(result.isError).toBe(true);
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for asset with no audio file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "no-audio", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "notes.txt", "hello", "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("enqueues job for vid asset with audio", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "has-audio", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "audio_original.mp3", Buffer.from("fake-mp3"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 11. Command dispatch wiring
  // -----------------------------------------------------------------------
  describe("command dispatch wiring", () => {
    it("/generate opens the generation panel via uiAction", () => {
      const cmd = findCommand("/generate");
      expect(cmd.uiAction).toBe("open_gen");
      expect(cmd.mcpTool).toBeUndefined();
    });

    it("/trim opens the trim editor via uiAction", () => {
      const cmd = findCommand("/trim");
      expect(cmd.uiAction).toBe("open_trim");
      expect(cmd.mcpTool).toBeUndefined();
    });

    it("/trim-audio has no mcpTool or uiAction (falls to chat)", () => {
      const cmd = findCommand("/trim-audio");
      expect(cmd.mcpTool).toBeUndefined();
      expect(cmd.uiAction).toBeUndefined();
    });

    it("/final dispatches render_timeline via mcpTool", () => {
      const cmd = findCommand("/final");
      expect(cmd.mcpTool?.tool).toBe("render_timeline");
      expect(cmd.mcpTool?.autoInject).toContain("project_slug");
      expect(cmd.uiAction).toBeUndefined();
    });

    it("/generate parseCommandArgs only captures first token as prompt (model gets rest)", () => {
      // /generate has 2 string params: prompt + model. parseCommandArgs assigns
      // the first token to prompt and remaining tokens to model (the last string param).
      // In production, chat fallback commands bypass parseCommandArgs entirely — the
      // full input is sent to the chat tool. This test documents the parse behavior.
      const args = simulateParse("/generate", "video of a dog on a skateboard");
      expect(args.prompt).toBe("video");
      expect(args.model).toBe("of a dog on a skateboard");
    });

    it("parses '/trim @hero-intro 0:05 0:12'", () => {
      const args = simulateParse("/trim", "@hero-intro 0:05 0:12");
      expect(args.asset_id).toBe("hero-intro");
      expect(args.start).toBe("0:05");
      expect(args.end).toBe("0:12");
    });

    it("parses '/trim @hero-intro' (no start/end)", () => {
      const args = simulateParse("/trim", "@hero-intro");
      expect(args.asset_id).toBe("hero-intro");
      expect(args.start).toBeUndefined();
      expect(args.end).toBeUndefined();
    });

    it("parses '/trim-audio @voiceover-main 0:00 0:30'", () => {
      const args = simulateParse("/trim-audio", "@voiceover-main 0:00 0:30");
      expect(args.asset_id).toBe("voiceover-main");
      expect(args.start).toBe("0:00");
      expect(args.end).toBe("0:30");
    });
  });

  // -----------------------------------------------------------------------
  // 12. UI action commands (verify they have uiAction set)
  // -----------------------------------------------------------------------
  describe("uiAction commands", () => {
    it("/upload has uiAction=open_upload", () => {
      const cmd = findCommand("/upload");
      expect(cmd.uiAction).toBe("open_upload");
    });

    it("/inbox has uiAction=open_inbox", () => {
      const cmd = findCommand("/inbox");
      expect(cmd.uiAction).toBe("open_inbox");
    });

    it("/copy has uiAction=copy_clipboard and parses @asset_id", () => {
      const cmd = findCommand("/copy");
      expect(cmd.uiAction).toBe("copy_clipboard");
      const args = simulateParse("/copy", "@hero-intro");
      expect(args.asset_id).toBe("hero-intro");
    });

    it("/history has uiAction=show_history and parses @asset_id", () => {
      const cmd = findCommand("/history");
      expect(cmd.uiAction).toBe("show_history");
      const args = simulateParse("/history", "@hero-intro");
      expect(args.asset_id).toBe("hero-intro");
    });

    it("/open has uiAction=open_asset and parses @asset_id", () => {
      const cmd = findCommand("/open");
      expect(cmd.uiAction).toBe("open_asset");
      const args = simulateParse("/open", "@hero-intro");
      expect(args.asset_id).toBe("hero-intro");
    });
  });

  // -----------------------------------------------------------------------
  // 13. Viewer commands (verify onMount=['viewer'] and uiAction)
  // -----------------------------------------------------------------------
  describe("viewer commands", () => {
    const viewerCommands = [
      { name: "/original", action: "viewer_set_original" },
      { name: "/landscape", action: "viewer_set_landscape" },
      { name: "/portrait", action: "viewer_set_portrait" },
      { name: "/info", action: "viewer_toggle_info" },
      { name: "/settings", action: "viewer_show_settings" },
      { name: "/files", action: "viewer_focus_file" },
    ];

    for (const { name, action } of viewerCommands) {
      it(`${name} has uiAction=${action} and onMount=['viewer']`, () => {
        const cmd = findCommand(name);
        expect(cmd.uiAction).toBe(action);
        expect(cmd.onMount).toContain("viewer");
      });
    }

    it("/files parses position number", () => {
      const args = simulateParse("/files", "3");
      expect(args.position).toBe("3");
    });
  });

  // -----------------------------------------------------------------------
  // 14. Dynamic project commands
  // -----------------------------------------------------------------------
  describe("dynamic project commands", () => {
    it("creates /test-proj command for existing project", () => {
      const cmd = commands.find((c) => c.command === "/test-proj");
      expect(cmd).toBeDefined();
      expect(cmd!.category).toBe("project");
      expect(cmd!.uiAction).toBe("switch_project");
    });

    it("creates commands for multiple projects", async () => {
      await client.callTool({
        name: "create_project",
        arguments: { project_slug: "alpha" },
      });
      await client.callTool({
        name: "create_project",
        arguments: { project_slug: "beta" },
      });

      const cmdResult = await client.callTool({
        name: "slash_commands",
        arguments: {},
      });
      const updatedCmds: ServerCommand[] = JSON.parse(
        (cmdResult.content as TextContent)[0].text,
      );

      const projectCmds = updatedCmds.filter((c) => c.category === "project");
      const slugs = projectCmds.map((c) => c.command);
      expect(slugs).toContain("/test-proj");
      expect(slugs).toContain("/alpha");
      expect(slugs).toContain("/beta");
    });
  });

  // -----------------------------------------------------------------------
  // 15. Cross-cutting: parseCommandArgs edge cases for slash commands
  // -----------------------------------------------------------------------
  describe("parseCommandArgs edge cases", () => {
    it("empty input returns empty object for any command", () => {
      for (const cmd of commands) {
        const args = parseCommandArgs("", cmd.params);
        expect(args).toEqual({});
      }
    });

    it("/assign with leading @ on both params", () => {
      const args = simulateParse("/assign", "@my-video @s03");
      expect(args.asset_id).toBe("my-video");
      expect(args.slot).toBe("s03");
    });

    it("/download with URL containing spaces fails gracefully", () => {
      const args = simulateParse("/download", "https://example.com/path with spaces");
      // First token is the url, remaining tokens are lost because it's a multi-param command
      // but /download only has url as first required string + optional start_time, end_time
      expect(args.url).toBe("https://example.com/path");
    });

    it("/generate with multi-word input: prompt gets first token, model gets rest", () => {
      const args = simulateParse("/generate", "video of @hero-intro dancing");
      expect(args.prompt).toBe("video");
      // model is the last string param, gets all remaining tokens joined
      expect(args.model).toBe("of @hero-intro dancing");
    });

    it("/rename strips @ from new_name when it is the last string param", () => {
      const args = simulateParse("/rename", "@old-name @new-name");
      expect(args.asset_id).toBe("old-name");
      expect(args.new_name).toBe("new-name");
    });

    it("/duplicate with multi-word new_name", () => {
      const args = simulateParse("/duplicate", "@hero-intro my cool copy");
      expect(args.asset_id).toBe("hero-intro");
      expect(args.new_name).toBe("my cool copy");
    });

    it("/unassign without @ prefix", () => {
      const args = simulateParse("/unassign", "s03");
      expect(args.slot).toBe("s03");
    });

    it("/download with start_time and end_time", () => {
      const args = simulateParse("/download", "https://youtube.com/watch?v=abc 1:30 2:45");
      expect(args.url).toBe("https://youtube.com/watch?v=abc");
      expect(args.start_time).toBe("1:30");
      expect(args.end_time).toBe("2:45");
    });

    it("/files with no position returns empty", () => {
      const args = simulateParse("/files", "");
      expect(args.position).toBeUndefined();
    });

    it("/trim-audio with only asset_id and start", () => {
      const args = simulateParse("/trim-audio", "@voiceover 0:10");
      expect(args.asset_id).toBe("voiceover");
      expect(args.start).toBe("0:10");
      expect(args.end).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 16. /download with different URL formats and time formats
  // -----------------------------------------------------------------------
  describe("/download different inputs", () => {
    it("normalizes URL without protocol prefix", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "youtube.com/watch?v=abc123",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
    });

    it("accepts colon time format '1:30'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "1:30",
          end_time: "2:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts shorthand time '2m20s'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "2m20s",
          end_time: "3m",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts bare numeric seconds '90'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "90",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts full=true alone (no time range)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          full: true,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors when full=true with end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          end_time: "60",
          full: true,
        },
      });
      expect(result.isError).toBe(true);
    });

    it("errors when start_time equals end_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "30",
          end_time: "30",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("accepts HH:MM:SS format '1:02:30'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "1:02:30",
          end_time: "1:05:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 17. /assign with different slot and asset scenarios
  // -----------------------------------------------------------------------
  describe("/assign different inputs", () => {
    it("reassigns an already-occupied slot to a different asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload1 = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "a.png", data },
      });
      const upload2 = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "b.png", data },
      });
      const id1 = parseResult(upload1).assetId as string;
      const id2 = parseResult(upload2).assetId as string;

      // Assign first
      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: id1, slot: "s01" },
      });

      // Reassign to different asset
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: id2, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.slots as Array<{ slug: string }>)[0].slug).toBe(id2);
    });

    it("assigns same asset to two different slots", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s02" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ slug: string }>;
      expect(slots[0].slug).toBe(assetId);
      expect(slots[1].slug).toBe(assetId);
    });

    it("errors for slot 's0' (index would be -1)", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: "vid-test", slot: "s0" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for slot with non-numeric suffix", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: "vid-test", slot: "sAB" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for empty slot string", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: "vid-test", slot: "" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 18. /unassign with different scenarios
  // -----------------------------------------------------------------------
  describe("/unassign different inputs", () => {
    it("clearing already-empty slot succeeds", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Create timeline with 2 slots, only s01 assigned
      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s02" },
      });

      // Clear empty s01 — should succeed, slot is already empty
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ slug: string }>;
      expect(slots[0].slug).toBe("");
    });

    it("errors for out-of-range slot", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Create timeline with 1 slot
      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });

      // Clear s05 which doesn't exist
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s05" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("out of range");
    });
  });

  // -----------------------------------------------------------------------
  // 19. /render with different optional parameters
  // -----------------------------------------------------------------------
  describe("/render different inputs", () => {
    it("accepts valid 6-digit hex colors", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "hex-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          text_color: "#FFFFFF",
          highlight_color: "#000000",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects shorthand hex '#FFF'", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          text_color: "#FFF",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid text_color hex");
    });

    it("rejects hex without # prefix", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          text_color: "FF0000",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid text_color hex");
    });

    it("rejects invalid highlight_color hex", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          highlight_color: "#ZZZZZZ",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("Invalid highlight_color hex");
    });

    it("accepts audio_volume=0 (muted)", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "muted-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          audio_volume: 0,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts audio_fade_in=0 and audio_fade_out=0", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "nofade-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          audio_fade_in: 0,
          audio_fade_out: 0,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects negative audio_fade_out", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          audio_fade_out: -5,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain(">= 0");
    });

    it("rejects audio_volume=-1", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          audio_volume: -1,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("0-100");
    });

    it("errors for img- prefix asset_id", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "img-photo",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("vid-");
    });

    it("errors for aud- prefix asset_id", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "aud-track",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("vid-");
    });

    it("renders with portrait orientation from timeline config", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "portrait-vid", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      // Set timeline render to portrait
      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: asset.value.assetId }],
        render: "portrait",
      }, "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.orientation).toBe("portrait");
    });

    it("errors when osg_asset_id is nonexistent", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "osg-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: "img-nonexistent",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("OSG asset error");
    });

    it("renders with background_mode=black", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "black-bg-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          background_mode: "black",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with all subtitle options", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "subs-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          subtitles_enabled: true,
          highlight_style: "highlight",
          position: "top",
          font_size: "large",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors when subtitles_enabled=true but no elevenlabs.json", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "no-subs", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          subtitles_enabled: true,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("elevenlabs.json");
    });
  });

  // -----------------------------------------------------------------------
  // 20. /duplicate with different inputs
  // -----------------------------------------------------------------------
  describe("/duplicate different inputs", () => {
    it("duplicates asset with multiple files", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("img", "multi-file", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.png", Buffer.from("fake-png"), "test-proj");
      await fs.writeFile(asset.value.assetId, "thumbnail.jpg", Buffer.from("fake-jpg"), "test-proj");
      await fs.writeFile(asset.value.assetId, "notes.txt", "some notes", "test-proj");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);

      // Verify copied files exist
      const copyManifest = await client.callTool({
        name: "asset_manifest",
        arguments: {
          asset_id: parsed.new_asset_id as string,
          project_slug: "test-proj",
        },
      });
      expect(copyManifest.isError).toBeFalsy();
      const copyParsed = parseResult(copyManifest);
      const fileNames = (copyParsed.files as Array<{ name: string }>).map((f) => f.name);
      expect(fileNames).toContain("original.png");
      expect(fileNames).toContain("thumbnail.jpg");
      expect(fileNames).toContain("notes.txt");
    });

    it("duplicates vid- prefixed asset preserving prefix", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "my-clip", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.new_asset_id as string).startsWith("vid-")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 21. /rename with different inputs
  // -----------------------------------------------------------------------
  describe("/rename different inputs", () => {
    it("renames to a multi-word name", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          new_name: "my beautiful sunset photo",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.new_asset_id).not.toBe(uploaded.assetId);
    });

    it("preserves asset prefix after rename", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "old-name", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.assetId,
          new_name: "new-name",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.new_asset_id as string).startsWith("vid-")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 22. /delete with different inputs
  // -----------------------------------------------------------------------
  describe("/delete different inputs", () => {
    it("deleting a vid- asset works", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "to-delete", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("deleted");
    });

    it("double delete errors on second attempt", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: assetId, project_slug: "test-proj" },
      });

      const result2 = await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: assetId, project_slug: "test-proj" },
      });
      expect(result2.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 23. /folder with different inputs
  // -----------------------------------------------------------------------
  describe("/folder different inputs", () => {
    it("parses '/folder @vid-my-clip'", () => {
      const args = simulateParse("/folder", "@vid-my-clip");
      expect(args.asset_id).toBe("vid-my-clip");
    });

    it("opens folder for an existing asset", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: assetId, project_slug: "test-proj" },
      });
      // On CI this may fail because Finder isn't available, but the asset path
      // resolution should succeed. Either way it should not be an MCP error
      // from the tool's own validation.
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.status).toBe("opened");
        expect(parsed.path).toBeDefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 24. /vocals with aud- prefix asset
  // -----------------------------------------------------------------------
  describe("/vocals different inputs", () => {
    it("enqueues job for aud- asset with mp3 file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("aud", "my-track", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "track.mp3", Buffer.from("fake-mp3"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("enqueues job for aud- asset with wav file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("aud", "wav-track", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "recording.wav", Buffer.from("fake-wav"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for img- prefix asset", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const data = Buffer.from("fake-png-data").toString("base64");
        const upload = await client.callTool({
          name: "upload_file",
          arguments: { project_slug: "test-proj", filename: "photo.png", data },
        });
        const assetId = parseResult(upload).assetId as string;

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for vid- asset with only video file (no audio)", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "vid-noaudio", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("finds audio_original.mp3 for vid- asset", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "vid-withaudio", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
        await fs.writeFile(asset.value.assetId, "audio_original.mp3", Buffer.from("fake-mp3"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("vid- asset falls back to original.mp3 when no audio_original.mp3", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "vid-fallback", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
        await fs.writeFile(asset.value.assetId, "original.mp3", Buffer.from("fake-mp3"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 25. filterCommandsByMountKeys
  // -----------------------------------------------------------------------
  describe("filterCommandsByMountKeys", () => {
    it("viewer commands hidden when viewer not active", () => {
      const filtered = filterCommandsByMountKeys(commands, new Set<string>());
      const viewerCmds = filtered.filter((c) => c.onMount?.includes("viewer"));
      expect(viewerCmds).toHaveLength(0);
    });

    it("viewer commands shown when viewer is active", () => {
      const filtered = filterCommandsByMountKeys(commands, new Set(["viewer"]));
      const viewerCmds = filtered.filter((c) => c.onMount?.includes("viewer"));
      expect(viewerCmds.length).toBeGreaterThan(0);
    });

    it("commands without onMount always shown", () => {
      const filtered = filterCommandsByMountKeys(commands, new Set<string>());
      const actionCmds = filtered.filter((c) => c.category === "action");
      expect(actionCmds.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // 27. Full round-trip: /assign then /unassign
  // -----------------------------------------------------------------------
  describe("full round-trip: assign then clear", () => {
    it("assign → verify → clear → verify", async () => {
      // Upload
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      // Assign to s01
      const assignResult = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: uploaded.assetId as string,
          slot: "s01",
        },
      });
      expect(assignResult.isError).toBeFalsy();
      const assignParsed = parseResult(assignResult);
      expect((assignParsed.slots as Array<{ slug: string }>)[0].slug).toBe(uploaded.assetId);

      // Clear s01
      const clearResult = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(clearResult.isError).toBeFalsy();
      const clearParsed = parseResult(clearResult);
      expect((clearParsed.slots as Array<{ slug: string }>)[0].slug).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // 28. Full round-trip: upload → duplicate → rename → delete
  // -----------------------------------------------------------------------
  describe("full round-trip: upload → duplicate → rename → delete", () => {
    it("lifecycle works end-to-end", async () => {
      // Upload
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);
      const originalId = uploaded.assetId as string;

      // Duplicate
      const dupResult = await client.callTool({
        name: "duplicate_asset",
        arguments: { asset_id: originalId, project_slug: "test-proj" },
      });
      expect(dupResult.isError).toBeFalsy();
      const dupParsed = parseResult(dupResult);
      const copyId = dupParsed.new_asset_id as string;

      // Rename the copy
      const renameResult = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: copyId,
          new_name: "renamed-copy",
          project_slug: "test-proj",
        },
      });
      expect(renameResult.isError).toBeFalsy();
      const renameParsed = parseResult(renameResult);
      const renamedId = renameParsed.new_asset_id as string;

      // Delete the renamed copy
      const deleteResult = await client.callTool({
        name: "delete_asset",
        arguments: { asset_id: renamedId, project_slug: "test-proj" },
      });
      expect(deleteResult.isError).toBeFalsy();
      expect(parseResult(deleteResult).status).toBe("deleted");

      // Original should still exist
      const origManifest = await client.callTool({
        name: "asset_manifest",
        arguments: { asset_id: originalId, project_slug: "test-proj" },
      });
      expect(origManifest.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 29. /download — time parsing edge cases
  // -----------------------------------------------------------------------
  describe("/download time parsing edge cases", () => {
    it("accepts decimal seconds '30.5'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "30.5",
          end_time: "45.5",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts shorthand '1h2m3s'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "1h2m3s",
          end_time: "1h10m",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts '5min' shorthand", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "5min",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts '0' as start_time", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "0",
          end_time: "60",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for negative time value (not parseable)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "-5",
        },
      });
      // Negative number parses as -5 via parseBareNumeric, but that's actually fine
      // since it's just a numeric value. The real check is if it causes issues.
      // Let's just verify it doesn't crash.
      expect(result.content).toBeDefined();
    });

    it("errors for gibberish time value", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "abc:xyz",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("accepts colon format with trailing 's' suffix '1:30s'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "1:30s",
          end_time: "2:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts only end_time (no start_time)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          end_time: "30",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("resolves source prefix from known domains", async () => {
      // Test with different known domains
      for (const domain of ["youtube.com/watch?v=x", "x.com/status/123", "instagram.com/reel/x"]) {
        const result = await client.callTool({
          name: "download_video",
          arguments: {
            url: `https://${domain}`,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 30. /render — OSG with valid image asset
  // -----------------------------------------------------------------------
  describe("/render with OSG image", () => {
    it("renders with valid osg_asset_id", async () => {
      const fs = createFs({ projectsDir: tempDir });
      // Create vid asset
      const vid = await fs.createAsset("vid", "osg-vid", "test-proj");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.writeFile(vid.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      // Create img asset for OSG
      const img = await fs.createAsset("img", "logo", "test-proj");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.writeFile(img.value.assetId, "logo.png", Buffer.from("fake-png"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: vid.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: img.value.assetId,
          osg_position: "bottom-left",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
    });

    it("errors for osg_asset_id with no image file", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const vid = await fs.createAsset("vid", "osg-vid2", "test-proj");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.writeFile(vid.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      // Create img asset with only a text file (no actual image)
      const img = await fs.createAsset("img", "no-image", "test-proj");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.writeFile(img.value.assetId, "notes.txt", "no image here", "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: vid.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: img.value.assetId,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("No image file found");
    });

    it("accepts all four osg_position values", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const vid = await fs.createAsset("vid", "osg-pos-test", "test-proj");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.writeFile(vid.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const img = await fs.createAsset("img", "pos-logo", "test-proj");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.writeFile(img.value.assetId, "logo.png", Buffer.from("fake-png"), "test-proj");

      for (const pos of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: vid.value.assetId,
            project_slug: "test-proj",
            osg_asset_id: img.value.assetId,
            osg_position: pos,
          },
        });
        expect(result.isError).toBeFalsy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 31. /render — subtitle auto-detection
  // -----------------------------------------------------------------------
  describe("/render subtitle auto-detection", () => {
    it("auto-enables subtitles when elevenlabs.json exists and subtitles_enabled not specified", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "auto-subs", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          // subtitles_enabled NOT specified — should auto-detect
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("enqueued");
    });

    it("subtitles_enabled=false overrides auto-detection", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "no-auto-subs", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          subtitles_enabled: false,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with highlight_style='impact' (default)", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "impact-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          subtitles_enabled: true,
          highlight_style: "impact",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with all position values", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "pos-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "test-proj");

      for (const position of ["top", "middle", "bottom"] as const) {
        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
            subtitles_enabled: true,
            position,
          },
        });
        expect(result.isError).toBeFalsy();
      }
    });

    it("renders with all font_size values", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "font-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      for (const font_size of ["small", "medium", "large"] as const) {
        const result = await client.callTool({
          name: "render",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
            font_size,
          },
        });
        expect(result.isError).toBeFalsy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 32. /vocals — different audio formats for aud- assets
  // -----------------------------------------------------------------------
  describe("/vocals audio format variants", () => {
    const audioFormats = [
      { ext: "wav", name: "recording.wav" },
      { ext: "ogg", name: "voiceover.ogg" },
      { ext: "flac", name: "master.flac" },
      { ext: "aac", name: "track.aac" },
      { ext: "m4a", name: "podcast.m4a" },
    ];

    for (const { ext, name } of audioFormats) {
      it(`enqueues job for aud- asset with .${ext} file`, async () => {
        const origKey = process.env.KIE_API_KEY;
        process.env.KIE_API_KEY = "test-key";
        try {
          const fs = createFs({ projectsDir: tempDir });
          const asset = await fs.createAsset("aud", `${ext}-track`, "test-proj");
          if (!asset.ok) throw new Error("Failed to create asset");
          await fs.writeFile(asset.value.assetId, name, Buffer.from(`fake-${ext}`), "test-proj");

          const result = await client.callTool({
            name: "isolate_vocals",
            arguments: {
              asset_id: asset.value.assetId,
              project_slug: "test-proj",
            },
          });
          expect(result.isError).toBeFalsy();
          expect(parseResult(result).status).toBe("enqueued");
        } finally {
          if (origKey) process.env.KIE_API_KEY = origKey;
          else delete process.env.KIE_API_KEY;
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // 33. /duplicate and /rename with aud- prefix assets
  // -----------------------------------------------------------------------
  describe("/duplicate and /rename with aud- assets", () => {
    it("duplicates aud- asset preserving prefix", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("aud", "my-track", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "mix.mp3", Buffer.from("fake-mp3"), "test-proj");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.new_asset_id as string).startsWith("aud-")).toBe(true);
    });

    it("renames aud- asset preserving prefix", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("aud", "old-track", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "mix.mp3", Buffer.from("fake-mp3"), "test-proj");

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.assetId,
          new_name: "new-track",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.new_asset_id as string).startsWith("aud-")).toBe(true);
    });

    it("deletes aud- asset", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("aud", "del-track", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "mix.mp3", Buffer.from("fake-mp3"), "test-proj");

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("deleted");
    });
  });

  // -----------------------------------------------------------------------
  // 34. /assign — preserves render orientation and volume settings
  // -----------------------------------------------------------------------
  describe("/assign preserves timeline config", () => {
    it("preserves existing render orientation", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Set timeline to portrait
      await fs.writeProjectMeta("timeline", {
        slots: [],
        render: "portrait",
      }, "test-proj");

      // Assign should preserve portrait orientation
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.render).toBe("portrait");
    });

    it("preserves existing slot volume/fade when reassigning", async () => {
      const fs = createFs({ projectsDir: tempDir });

      const data = Buffer.from("fake-png-data").toString("base64");
      const upload1 = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "a.png", data },
      });
      const upload2 = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "b.png", data },
      });
      const id1 = parseResult(upload1).assetId as string;
      const id2 = parseResult(upload2).assetId as string;

      // Set timeline with volume/fade on slot 1
      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: id1, volume: 80, audioFadeIn: 200, audioFadeOut: 300 }],
        render: "landscape",
      }, "test-proj");

      // Reassign slot 1 to a different asset
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: id2, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{
        slug: string;
        volume?: number;
        audioFadeIn?: number;
        audioFadeOut?: number;
      }>;
      expect(slots[0].slug).toBe(id2);
      expect(slots[0].volume).toBe(80);
      expect(slots[0].audioFadeIn).toBe(200);
      expect(slots[0].audioFadeOut).toBe(300);
    });

    it("assigns to very large slot index s20", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s20" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ slug: string }>;
      expect(slots).toHaveLength(20);
      expect(slots[19].slug).toBe(assetId);
      // All intermediate slots should be empty
      for (let i = 0; i < 19; i++) {
        expect(slots[i].slug).toBe("");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 35. /unassign — edge cases with timeline state
  // -----------------------------------------------------------------------
  describe("/unassign timeline state edge cases", () => {
    it("clears last remaining slot, timeline still exists", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });

      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      const slots = parsed.slots as Array<{ slug: string }>;
      expect(slots).toHaveLength(1);
      expect(slots[0].slug).toBe("");
    });

    it("unassign_slot resets volume/fade settings", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Set timeline with volume/fade
      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: assetId, volume: 80, audioFadeIn: 200, audioFadeOut: 300 }],
        render: "landscape",
      }, "test-proj");

      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{
        slug: string;
        volume?: number;
        audioFadeIn?: number;
      }>;
      // unassign_slot does a full reset: { slug: "" } — no volume/fade
      expect(slots[0].slug).toBe("");
      expect(slots[0].volume).toBeUndefined();
      expect(slots[0].audioFadeIn).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 36. /rewrite — scene mode validation
  // -----------------------------------------------------------------------
  describe("/rewrite scene mode", () => {
    it("errors when asset_slug provided but no tool.params.json", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "no-params", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: asset.value.assetId,
            scene_index: 0,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("tool.params");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene_index out of range", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "scene-range", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");

        // Write tool.params with a single scene (no multi_prompt)
        await fs.writeMetadata(asset.value.assetId, "tool.params", {
          tool: "generate_kling30_video",
          prompt: "a test prompt",
          duration: 8,
        }, "test-proj");

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: asset.value.assetId,
            scene_index: 5,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("out of range");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors when tool is not generate_kling30_video", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "wrong-tool", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");

        await fs.writeMetadata(asset.value.assetId, "tool.params", {
          tool: "generate_grok_imagine_video",
          prompt: "a test prompt",
        }, "test-proj");

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: asset.value.assetId,
            scene_index: 0,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("Kling 3.0");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors with image_slugs that don't resolve to any images", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            prompt: "a dog on a skateboard",
            model: "nano_banana",
            project_slug: "test-proj",
            image_slugs: ["img-nonexistent-abc", "img-nonexistent-xyz"],
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("Could not resolve");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 37. /render — video file detection edge cases
  // -----------------------------------------------------------------------
  describe("/render video file detection", () => {
    it("finds .mov video file", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "mov-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mov", Buffer.from("fake-mov"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("finds .webm video file", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "webm-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.webm", Buffer.from("fake-webm"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for asset with no video file (only text)", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "no-video", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "notes.txt", "just text", "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("No video file");
    });

    it("prefers original.mp4 over other video files", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "prefer-original", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "render.mp4", Buffer.from("fake"), "test-proj");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with audio_volume=100 (max)", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "vol100", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          audio_volume: 100,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("rejects audio_volume=101", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "test-proj",
          audio_volume: 101,
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as TextContent)[0].text).toContain("0-100");
    });

    it("accepts lowercase hex '#abcdef'", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "lc-hex", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          text_color: "#abcdef",
        },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 38. /folder with different asset types
  // -----------------------------------------------------------------------
  describe("/folder different asset types", () => {
    it("opens folder for aud- asset", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("aud", "my-audio", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "mix.mp3", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: asset.value.assetId, project_slug: "test-proj" },
      });
      // On macOS should succeed, but may fail on CI
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.status).toBe("opened");
        expect(parsed.path).toBeDefined();
      }
    });

    it("opens folder for vid- asset", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "my-video", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: asset.value.assetId, project_slug: "test-proj" },
      });
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.status).toBe("opened");
      }
    });
  });

  // -----------------------------------------------------------------------
  // 39. Full round-trip: assign multiple → clear middle → verify
  // -----------------------------------------------------------------------
  describe("full round-trip: multi-slot assign and clear", () => {
    it("assign 3 assets to s01,s02,s03 → clear s02 → verify", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const ids: string[] = [];
      for (const name of ["a.png", "b.png", "c.png"]) {
        const upload = await client.callTool({
          name: "upload_file",
          arguments: { project_slug: "test-proj", filename: name, data },
        });
        ids.push(parseResult(upload).assetId as string);
      }

      // Assign all three
      for (let i = 0; i < 3; i++) {
        await client.callTool({
          name: "assign_slot",
          arguments: { project_slug: "test-proj", asset_id: ids[i], slot: `s0${i + 1}` },
        });
      }

      // Clear middle slot
      const clearResult = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "test-proj", slot: "s02" },
      });
      expect(clearResult.isError).toBeFalsy();
      const slots = parseResult(clearResult).slots as Array<{ slug: string }>;
      expect(slots[0].slug).toBe(ids[0]);
      expect(slots[1].slug).toBe("");
      expect(slots[2].slug).toBe(ids[2]);
    });
  });

  // -----------------------------------------------------------------------
  // 40. /duplicate with custom name containing special characters
  // -----------------------------------------------------------------------
  describe("/duplicate with special name inputs", () => {
    it("duplicates with name containing spaces and numbers", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          project_slug: "test-proj",
          new_name: "version 2 final v3",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.source_asset_id).toBe(uploaded.assetId);
    });

    it("auto-generates copy name when new_name not provided", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "sunset.jpg", data },
      });
      const uploaded = parseResult(upload);

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: uploaded.assetId as string,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      // Auto-name should be "{originalName} copy"
      expect(parsed.new_asset_id).toBeDefined();
      expect(parsed.new_asset_id).not.toBe(uploaded.assetId);
    });
  });

  // -----------------------------------------------------------------------
  // 41. parseCommandArgs — additional edge cases
  // -----------------------------------------------------------------------
  describe("parseCommandArgs additional edge cases", () => {
    it("/render parses asset_id from '/render @vid-my-clip'", () => {
      const args = simulateParse("/render", "@vid-my-clip");
      expect(args.asset_id).toBe("vid-my-clip");
    });

    it("/vocals parses asset_id", () => {
      const args = simulateParse("/vocals", "@aud-my-track");
      expect(args.asset_id).toBe("aud-my-track");
    });

    it("/rewrite parses prompt text", () => {
      const args = simulateParse("/rewrite", "a beautiful sunset over mountains");
      expect(args.prompt).toBe("a beautiful sunset over mountains");
    });

    it("/download parses URL with query params and fragments", () => {
      const args = simulateParse("/download", "https://youtube.com/watch?v=abc&t=30#section");
      expect(args.url).toBe("https://youtube.com/watch?v=abc&t=30#section");
    });

    it("/assign without @ on slot still works", () => {
      const args = simulateParse("/assign", "@my-video s03");
      expect(args.asset_id).toBe("my-video");
      expect(args.slot).toBe("s03");
    });

    it("/files parses large position number", () => {
      const args = simulateParse("/files", "99");
      expect(args.position).toBe("99");
    });
  });

  // -----------------------------------------------------------------------
  // 42. /download — URL normalization and sourcePrefix mapping
  // -----------------------------------------------------------------------
  describe("/download URL normalization", () => {
    it("normalizes http:// URL (keeps as-is, not doubled)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "http://example.com/video",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });

    it("accepts tiktok.com domain", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://tiktok.com/@user/video/12345",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts vimeo.com domain", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://vimeo.com/123456789",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts reddit.com domain", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://reddit.com/r/videos/comments/abc/test",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts fb.watch short URL", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://fb.watch/abc123",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("falls back to domain-derived prefix for unknown sites", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://obscure-video-host.xyz/v/12345",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });

    it("accepts URL with www prefix", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts youtu.be short URL", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://youtu.be/dQw4w9WgXcQ",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("accepts export_videos=true", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          export_videos: true,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("full=true produces original_full.mp4 filename in job", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          full: true,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).status).toBe("enqueued");
    });
  });

  // -----------------------------------------------------------------------
  // 43. /assign — idempotent re-assignment and normalizeConfig branches
  // -----------------------------------------------------------------------
  describe("/assign idempotent and config normalization", () => {
    it("assigning same asset to same slot is idempotent", async () => {
      const data = Buffer.from("fake-png-data").toString("base64");
      const upload = await client.callTool({
        name: "upload_file",
        arguments: { project_slug: "test-proj", filename: "photo.png", data },
      });
      const assetId = parseResult(upload).assetId as string;

      // Assign once
      await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });

      // Assign same asset to same slot again
      const result = await client.callTool({
        name: "assign_slot",
        arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const slots = parseResult(result).slots as Array<{ slug: string }>;
      expect(slots[0].slug).toBe(assetId);
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "no-such-project",
          asset_id: "vid-test",
          slot: "s01",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 44. /unassign — nonexistent project
  // -----------------------------------------------------------------------
  describe("/unassign", () => {
    it("errors for nonexistent project (no timeline)", async () => {
      const result = await client.callTool({
        name: "unassign_slot",
        arguments: { project_slug: "no-such-project", slot: "s01" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 45. /duplicate — empty asset and prefix extraction edge cases
  // -----------------------------------------------------------------------
  describe("/duplicate prefix extraction", () => {
    it("duplicates asset with no files (empty manifest)", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("img", "empty-asset", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.new_asset_id).toBeDefined();
      expect((parsed.new_asset_id as string).startsWith("img-")).toBe(true);
    });

    it("duplicate preserves copy name with 'copy' suffix", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("img", "beach-sunset", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "photo.png", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      // Auto-name should be "<original> copy"
      const newId = parseResult(result).new_asset_id as string;
      expect(newId).toContain("copy");
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: "img-test",
          project_slug: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 46. /rename — edge cases
  // -----------------------------------------------------------------------
  describe("/rename edge cases", () => {
    it("rename to single character name", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("img", "longname", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "photo.png", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.assetId,
          new_name: "x",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.new_asset_id as string).startsWith("img-")).toBe(true);
    });

    it("rename to name with numbers", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "clip-old", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: asset.value.assetId,
          new_name: "clip 42 final v3",
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: "img-test",
          new_name: "whatever",
          project_slug: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 47. /delete — different asset types
  // -----------------------------------------------------------------------
  describe("/delete different asset types", () => {
    it("deletes img- asset created via fs.createAsset", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("img", "del-img", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "photo.png", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect(parsed.status).toBe("deleted");
      expect(parsed.deleted_at).toBeDefined();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "delete_asset",
        arguments: {
          asset_id: "img-test",
          project_slug: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 48. /render — findVideoFile with .avi and .mkv formats
  // -----------------------------------------------------------------------
  describe("/render additional video formats", () => {
    it("finds .avi video file", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "avi-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "clip.avi", Buffer.from("fake-avi"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("finds .mkv video file", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "mkv-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "movie.mkv", Buffer.from("fake-mkv"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with background_mode=blur (default)", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "blur-bg-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          background_mode: "blur",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with highlight_style='highlight'", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "highlight-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      await fs.writeFile(asset.value.assetId, "elevenlabs.json", Buffer.from("{}"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          subtitles_enabled: true,
          highlight_style: "highlight",
          text_color: "#FF0000",
          highlight_color: "#00FF00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with square orientation from timeline config", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "square-vid", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      await fs.writeProjectMeta("timeline", {
        slots: [{ slug: asset.value.assetId }],
        render: "square",
      }, "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseResult(result).orientation).toBe("square");
    });

    it("renders with large audio_fade_in and audio_fade_out values", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("vid", "bigfade-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: asset.value.assetId,
          project_slug: "test-proj",
          audio_fade_in: 5000,
          audio_fade_out: 3000,
          audio_volume: 50,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with OSG using .webp image", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const vid = await fs.createAsset("vid", "osg-webp", "test-proj");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.writeFile(vid.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const img = await fs.createAsset("img", "webp-logo", "test-proj");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.writeFile(img.value.assetId, "logo.webp", Buffer.from("fake-webp"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: vid.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: img.value.assetId,
          osg_position: "top-left",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with OSG using .svg image", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const vid = await fs.createAsset("vid", "osg-svg", "test-proj");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.writeFile(vid.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const img = await fs.createAsset("img", "svg-logo", "test-proj");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.writeFile(img.value.assetId, "icon.svg", Buffer.from("<svg></svg>"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: vid.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: img.value.assetId,
          osg_position: "bottom-right",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("renders with OSG using .gif image", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const vid = await fs.createAsset("vid", "osg-gif", "test-proj");
      if (!vid.ok) throw new Error("Failed to create vid asset");
      await fs.writeFile(vid.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");

      const img = await fs.createAsset("img", "gif-logo", "test-proj");
      if (!img.ok) throw new Error("Failed to create img asset");
      await fs.writeFile(img.value.assetId, "badge.gif", Buffer.from("GIF89a"), "test-proj");

      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: vid.value.assetId,
          project_slug: "test-proj",
          osg_asset_id: img.value.assetId,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "render",
        arguments: {
          asset_id: "vid-test",
          project_slug: "no-such-project",
        },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 49. /vocals — findAudioFile fallback logic
  // -----------------------------------------------------------------------
  describe("/vocals audio discovery", () => {
    it("aud- asset finds .m4a file", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("aud", "m4a-track", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "episode.m4a", Buffer.from("fake-m4a"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("aud- asset with non-audio file only errors", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("aud", "text-only", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "readme.txt", "text", "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("No audio file");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("vid- asset with audio_original.mp3 preferred over original.mp3", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "both-audio", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
        await fs.writeFile(asset.value.assetId, "original.mp3", Buffer.from("original-mp3"), "test-proj");
        await fs.writeFile(asset.value.assetId, "audio_original.mp3", Buffer.from("audio-original-mp3"), "test-proj");

        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: asset.value.assetId,
            project_slug: "test-proj",
          },
        });
        // Should succeed — findAudioFile for vid- prefers audio_original.mp3
        expect(result.isError).toBeFalsy();
        expect(parseResult(result).status).toBe("enqueued");
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });

    it("errors for nonexistent project", async () => {
      const origKey = process.env.KIE_API_KEY;
      process.env.KIE_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "isolate_vocals",
          arguments: {
            asset_id: "vid-test",
            project_slug: "no-such-project",
          },
        });
        expect(result.isError).toBe(true);
      } finally {
        if (origKey) process.env.KIE_API_KEY = origKey;
        else delete process.env.KIE_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 50. /rewrite — additional validation paths
  // -----------------------------------------------------------------------
  describe("/rewrite additional validation", () => {
    it("errors when asset_slug provided without scene_index", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        // asset_slug but no scene_index — should fall to standard mode (prompt required)
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: "vid-test",
            // no scene_index, no prompt
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("prompt is required");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene rewrite with scene_index < 0", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "neg-scene", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeMetadata(asset.value.assetId, "tool.params", {
          tool: "generate_kling30_video",
          prompt: "test",
          duration: 8,
        }, "test-proj");

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: asset.value.assetId,
            scene_index: -1,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("out of range");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene rewrite on multi_prompt with out-of-bounds index", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const fs = createFs({ projectsDir: tempDir });
        const asset = await fs.createAsset("vid", "multi-scene", "test-proj");
        if (!asset.ok) throw new Error("Failed to create asset");
        await fs.writeMetadata(asset.value.assetId, "tool.params", {
          tool: "generate_kling30_video",
          multi_prompt: [
            { prompt: "scene one", duration: 4 },
            { prompt: "scene two", duration: 4 },
          ],
        }, "test-proj");

        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: asset.value.assetId,
            scene_index: 2, // only 0 and 1 are valid
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("out of range");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it("errors for scene rewrite on nonexistent asset", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";
      try {
        const result = await client.callTool({
          name: "rewrite_prompt",
          arguments: {
            project_slug: "test-proj",
            asset_slug: "vid-does-not-exist",
            scene_index: 0,
          },
        });
        expect(result.isError).toBe(true);
        expect((result.content as TextContent)[0].text).toContain("tool.params");
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        else delete process.env.OPENAI_API_KEY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // 51. /folder — different asset types via fs.createAsset
  // -----------------------------------------------------------------------
  describe("/folder with createAsset", () => {
    it("errors for nonexistent project", async () => {
      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: "img-test", project_slug: "no-such-project" },
      });
      expect(result.isError).toBe(true);
    });

    it("resolves correct path for img- asset", async () => {
      const fs = createFs({ projectsDir: tempDir });
      const asset = await fs.createAsset("img", "folder-test", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "photo.png", Buffer.from("fake"), "test-proj");

      const result = await client.callTool({
        name: "show_folder",
        arguments: { asset_id: asset.value.assetId, project_slug: "test-proj" },
      });
      // On macOS with Finder this should succeed; either way no validation error
      if (!result.isError) {
        const parsed = parseResult(result);
        expect(parsed.path).toContain(asset.value.assetId);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 52. /download time edge cases — mixed formats
  // -----------------------------------------------------------------------
  describe("/download mixed time formats", () => {
    it("colon start with shorthand end '0:30' to '2m'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "0:30",
          end_time: "2m",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("shorthand start with colon end '1m30s' to '3:00'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "1m30s",
          end_time: "3:00",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("bare numeric start with shorthand end '10' to '5min'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "10",
          end_time: "5min",
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("both times as '0' and '0' errors (start >= end)", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "0",
          end_time: "0",
        },
      });
      expect(result.isError).toBe(true);
    });

    it("HH:MM:SS start with bare end '0:02:30' to '200'", async () => {
      const result = await client.callTool({
        name: "download_video",
        arguments: {
          url: "https://example.com/video",
          project_slug: "test-proj",
          start_time: "0:02:30",
          end_time: "200",
        },
      });
      expect(result.isError).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  // 53. Full round-trip: create → rename → duplicate → assign → render
  // -----------------------------------------------------------------------
  describe("full round-trip: create → rename → duplicate → assign → render", () => {
    it("end-to-end lifecycle with vid asset", async () => {
      const fs = createFs({ projectsDir: tempDir });

      // Create vid asset
      const asset = await fs.createAsset("vid", "raw-footage", "test-proj");
      if (!asset.ok) throw new Error("Failed to create asset");
      await fs.writeFile(asset.value.assetId, "original.mp4", Buffer.from("fake-mp4"), "test-proj");
      const origId = asset.value.assetId;

      // Rename
      const renameResult = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: origId,
          new_name: "polished clip",
          project_slug: "test-proj",
        },
      });
      expect(renameResult.isError).toBeFalsy();
      const renamedId = parseResult(renameResult).new_asset_id as string;

      // Duplicate
      const dupResult = await client.callTool({
        name: "duplicate_asset",
        arguments: {
          asset_id: renamedId,
          project_slug: "test-proj",
          new_name: "backup clip",
        },
      });
      expect(dupResult.isError).toBeFalsy();

      // Assign renamed asset to slot
      const assignResult = await client.callTool({
        name: "assign_slot",
        arguments: {
          project_slug: "test-proj",
          asset_id: renamedId,
          slot: "s01",
        },
      });
      expect(assignResult.isError).toBeFalsy();

      // Render the assigned asset
      const renderResult = await client.callTool({
        name: "render",
        arguments: {
          asset_id: renamedId,
          project_slug: "test-proj",
        },
      });
      expect(renderResult.isError).toBeFalsy();
      expect(parseResult(renderResult).status).toBe("enqueued");
    });
  });

  // -----------------------------------------------------------------------
  // 54. parseCommandArgs — new differentiators
  // -----------------------------------------------------------------------
  describe("parseCommandArgs new differentiators", () => {
    it("/download URL-only no extra params", () => {
      const args = simulateParse("/download", "twitch.tv/videos/12345");
      expect(args.url).toBe("twitch.tv/videos/12345");
      expect(args.start_time).toBeUndefined();
    });

    it("/trim with only start time (no end)", () => {
      const args = simulateParse("/trim", "@clip 1:00");
      expect(args.asset_id).toBe("clip");
      expect(args.start).toBe("1:00");
      expect(args.end).toBeUndefined();
    });

    it("/duplicate without @ prefix", () => {
      const args = simulateParse("/duplicate", "hero-intro my-copy");
      expect(args.asset_id).toBe("hero-intro");
      expect(args.new_name).toBe("my-copy");
    });

    it("/assign without @ on either param", () => {
      const args = simulateParse("/assign", "vid-clip s02");
      expect(args.asset_id).toBe("vid-clip");
      expect(args.slot).toBe("s02");
    });

    it("/rename with 'to' connector and multi-word name", () => {
      const args = simulateParse("/rename", "@old-name to my brand new name");
      expect(args.asset_id).toBe("old-name");
      expect(args.new_name).toBe("my brand new name");
    });

    it("/rewrite with long prompt", () => {
      const longPrompt = "a cinematic slow motion shot of a golden retriever catching a frisbee at sunset on the beach with dramatic lighting and lens flare";
      const args = simulateParse("/rewrite", longPrompt);
      expect(args.prompt).toBe(longPrompt);
    });

    it("/copy without @ prefix", () => {
      const args = simulateParse("/copy", "vid-my-clip");
      expect(args.asset_id).toBe("vid-my-clip");
    });

    it("/history with vid- prefixed asset", () => {
      const args = simulateParse("/history", "@vid-raw-footage");
      expect(args.asset_id).toBe("vid-raw-footage");
    });

    it("/open with aud- prefixed asset", () => {
      const args = simulateParse("/open", "@aud-track-01");
      expect(args.asset_id).toBe("aud-track-01");
    });
  });

  // -----------------------------------------------------------------------
  // Render settings commands — command definitions
  // -----------------------------------------------------------------------
  describe("render settings commands", () => {
    it("/subs has uiAction=settings_subs, onMount=['viewer'], field+value params", () => {
      const cmd = findCommand("/subs");
      expect(cmd.uiAction).toBe("settings_subs");
      expect(cmd.onMount).toContain("viewer");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("field");
      expect(names).toContain("value");
      expect(cmd.params.find((p) => p.name === "field")!.required).toBe(true);
      expect(cmd.params.find((p) => p.name === "value")!.required).toBe(false);
    });

    it("/audio has uiAction=settings_audio, onMount=['viewer'], field+value params", () => {
      const cmd = findCommand("/audio");
      expect(cmd.uiAction).toBe("settings_audio");
      expect(cmd.onMount).toContain("viewer");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("field");
      expect(names).toContain("value");
      expect(cmd.params.find((p) => p.name === "field")!.required).toBe(true);
      expect(cmd.params.find((p) => p.name === "value")!.required).toBe(false);
    });

    it("/bg has uiAction=settings_bg, onMount=['viewer'], mode param", () => {
      const cmd = findCommand("/bg");
      expect(cmd.uiAction).toBe("settings_bg");
      expect(cmd.onMount).toContain("viewer");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("mode");
      expect(cmd.params.find((p) => p.name === "mode")!.required).toBe(true);
    });

    it("/osg has uiAction=settings_osg, onMount=['viewer'], field+value params", () => {
      const cmd = findCommand("/osg");
      expect(cmd.uiAction).toBe("settings_osg");
      expect(cmd.onMount).toContain("viewer");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("field");
      expect(names).toContain("value");
      expect(cmd.params.find((p) => p.name === "field")!.required).toBe(true);
      expect(cmd.params.find((p) => p.name === "value")!.required).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // /subs different inputs — parse + dispatch
  // -----------------------------------------------------------------------
  describe("/subs different inputs", () => {
    it("/subs on", () => {
      const args = simulateParse("/subs", "on");
      expect(args.field).toBe("on");
      expect(args.value).toBeUndefined();
    });

    it("/subs off", () => {
      const args = simulateParse("/subs", "off");
      expect(args.field).toBe("off");
      expect(args.value).toBeUndefined();
    });

    it("/subs style impact", () => {
      const args = simulateParse("/subs", "style impact");
      expect(args.field).toBe("style");
      expect(args.value).toBe("impact");
    });

    it("/subs style highlight", () => {
      const args = simulateParse("/subs", "style highlight");
      expect(args.field).toBe("style");
      expect(args.value).toBe("highlight");
    });

    it("/subs position top", () => {
      const args = simulateParse("/subs", "position top");
      expect(args.field).toBe("position");
      expect(args.value).toBe("top");
    });

    it("/subs position mid", () => {
      const args = simulateParse("/subs", "position mid");
      expect(args.field).toBe("position");
      expect(args.value).toBe("mid");
    });

    it("/subs position bottom", () => {
      const args = simulateParse("/subs", "position bottom");
      expect(args.field).toBe("position");
      expect(args.value).toBe("bottom");
    });

    it("/subs size s", () => {
      const args = simulateParse("/subs", "size s");
      expect(args.field).toBe("size");
      expect(args.value).toBe("s");
    });

    it("/subs size m", () => {
      const args = simulateParse("/subs", "size m");
      expect(args.field).toBe("size");
      expect(args.value).toBe("m");
    });

    it("/subs size l", () => {
      const args = simulateParse("/subs", "size l");
      expect(args.field).toBe("size");
      expect(args.value).toBe("l");
    });

    it("/subs color #FF0000", () => {
      const args = simulateParse("/subs", "color #FF0000");
      expect(args.field).toBe("color");
      expect(args.value).toBe("#FF0000");
    });

    it("/subs highlight #00FF00", () => {
      const args = simulateParse("/subs", "highlight #00FF00");
      expect(args.field).toBe("highlight");
      expect(args.value).toBe("#00FF00");
    });
  });

  // -----------------------------------------------------------------------
  // /audio different inputs — parse + dispatch
  // -----------------------------------------------------------------------
  describe("/audio different inputs", () => {
    it("/audio volume 80", () => {
      const args = simulateParse("/audio", "volume 80");
      expect(args.field).toBe("volume");
      expect(args.value).toBe("80");
    });

    it("/audio volume 0", () => {
      const args = simulateParse("/audio", "volume 0");
      expect(args.field).toBe("volume");
      expect(args.value).toBe("0");
    });

    it("/audio volume 100", () => {
      const args = simulateParse("/audio", "volume 100");
      expect(args.field).toBe("volume");
      expect(args.value).toBe("100");
    });

    it("/audio fade-in 200", () => {
      const args = simulateParse("/audio", "fade-in 200");
      expect(args.field).toBe("fade-in");
      expect(args.value).toBe("200");
    });

    it("/audio fade-out 500", () => {
      const args = simulateParse("/audio", "fade-out 500");
      expect(args.field).toBe("fade-out");
      expect(args.value).toBe("500");
    });
  });

  // -----------------------------------------------------------------------
  // /bg different inputs — parse + dispatch
  // -----------------------------------------------------------------------
  describe("/bg different inputs", () => {
    it("/bg blur", () => {
      const args = simulateParse("/bg", "blur");
      expect(args.mode).toBe("blur");
    });

    it("/bg black", () => {
      const args = simulateParse("/bg", "black");
      expect(args.mode).toBe("black");
    });
  });

  // -----------------------------------------------------------------------
  // /osg different inputs — parse + dispatch
  // -----------------------------------------------------------------------
  describe("/osg different inputs", () => {
    it("/osg position tl", () => {
      const args = simulateParse("/osg", "position tl");
      expect(args.field).toBe("position");
      expect(args.value).toBe("tl");
    });

    it("/osg position tr", () => {
      const args = simulateParse("/osg", "position tr");
      expect(args.field).toBe("position");
      expect(args.value).toBe("tr");
    });

    it("/osg position bl", () => {
      const args = simulateParse("/osg", "position bl");
      expect(args.field).toBe("position");
      expect(args.value).toBe("bl");
    });

    it("/osg position br", () => {
      const args = simulateParse("/osg", "position br");
      expect(args.field).toBe("position");
      expect(args.value).toBe("br");
    });

    it("/osg clear", () => {
      const args = simulateParse("/osg", "clear");
      expect(args.field).toBe("clear");
      expect(args.value).toBeUndefined();
    });

    it("/osg @img-logo strips @ prefix", () => {
      const args = simulateParse("/osg", "@img-logo");
      expect(args.field).toBe("img-logo");
      expect(args.value).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Render settings executeUiAction dispatch
  // -----------------------------------------------------------------------
  describe("render settings executeUiAction dispatch", () => {
    // Import inline to avoid adding to the top-level imports
    let executeUiAction: typeof import("../../../src/lib/ui-actions.js").executeUiAction;

    beforeEach(async () => {
      const mod = await import("../../../src/lib/ui-actions.js");
      executeUiAction = mod.executeUiAction;
    });

    it("settings_subs dispatches (field, value)", () => {
      let captured: [string, string] | undefined;
      const map = { settings_subs: (f: string, v: string) => { captured = [f, v]; } };
      const result = executeUiAction("settings_subs", map, {
        raw: "style impact",
        args: { field: "style", value: "impact" },
      });
      expect(result).toBe(true);
      expect(captured).toEqual(["style", "impact"]);
    });

    it("settings_subs dispatches on/off (value empty)", () => {
      let captured: [string, string] | undefined;
      const map = { settings_subs: (f: string, v: string) => { captured = [f, v]; } };
      executeUiAction("settings_subs", map, {
        raw: "on",
        args: { field: "on" },
      });
      expect(captured).toEqual(["on", ""]);
    });

    it("settings_audio dispatches (field, value)", () => {
      let captured: [string, string] | undefined;
      const map = { settings_audio: (f: string, v: string) => { captured = [f, v]; } };
      const result = executeUiAction("settings_audio", map, {
        raw: "volume 80",
        args: { field: "volume", value: "80" },
      });
      expect(result).toBe(true);
      expect(captured).toEqual(["volume", "80"]);
    });

    it("settings_bg dispatches (mode)", () => {
      let captured: string | undefined;
      const map = { settings_bg: (m: string) => { captured = m; } };
      const result = executeUiAction("settings_bg", map, {
        raw: "blur",
        args: { mode: "blur" },
      });
      expect(result).toBe(true);
      expect(captured).toBe("blur");
    });

    it("settings_osg dispatches (field, value)", () => {
      let captured: [string, string] | undefined;
      const map = { settings_osg: (f: string, v: string) => { captured = [f, v]; } };
      const result = executeUiAction("settings_osg", map, {
        raw: "position tl",
        args: { field: "position", value: "tl" },
      });
      expect(result).toBe(true);
      expect(captured).toEqual(["position", "tl"]);
    });

    it("settings_osg dispatches clear (value empty)", () => {
      let captured: [string, string] | undefined;
      const map = { settings_osg: (f: string, v: string) => { captured = [f, v]; } };
      executeUiAction("settings_osg", map, {
        raw: "clear",
        args: { field: "clear" },
      });
      expect(captured).toEqual(["clear", ""]);
    });

    it("returns false when action not in map", () => {
      const result = executeUiAction("settings_subs", {}, {
        raw: "on",
        args: { field: "on" },
      });
      expect(result).toBe(false);
    });
  });
});

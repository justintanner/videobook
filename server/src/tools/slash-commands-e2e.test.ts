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
import { createFs } from "clipfirst-fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parseCommandArgs } from "../../../src/lib/command-registry.js";
import type { ServerCommand } from "../../../src/lib/command-registry.js";

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as TextContent)[0].text);
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
  // 1. /download — download_video_file
  // -----------------------------------------------------------------------
  describe("/download", () => {
    it("parses '/download https://youtube.com/watch?v=abc'", () => {
      const args = simulateParse("/download", "https://youtube.com/watch?v=abc");
      expect(args.url).toBe("https://youtube.com/watch?v=abc");
    });

    it("enqueues a download job for a valid URL", async () => {
      const result = await client.callTool({
        name: "download_video_file",
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
        name: "download_video_file",
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
        name: "download_video_file",
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
        name: "download_video_file",
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
        name: "download_video_file",
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
  // 2. /show-folder — show_folder
  // -----------------------------------------------------------------------
  describe("/show-folder", () => {
    it("parses '/show-folder @product-shot'", () => {
      const args = simulateParse("/show-folder", "@product-shot");
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
  // 7. /clear-slot — clear_slot
  // -----------------------------------------------------------------------
  describe("/clear-slot", () => {
    it("parses '/clear-slot @s02'", () => {
      const args = simulateParse("/clear-slot", "@s02");
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
        name: "clear_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = parseResult(result);
      expect((parsed.slots as Array<{ slug: string }>)[0].slug).toBe("");
    });

    it("errors for invalid slot format", async () => {
      const result = await client.callTool({
        name: "clear_slot",
        arguments: { project_slug: "test-proj", slot: "xyz" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for slot s00", async () => {
      const result = await client.callTool({
        name: "clear_slot",
        arguments: { project_slug: "test-proj", slot: "s00" },
      });
      expect(result.isError).toBe(true);
    });

    it("errors for no timeline", async () => {
      const result = await client.callTool({
        name: "clear_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(result.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 8. /rewrite-prompt — rewrite_prompt (validation only, no API key)
  // -----------------------------------------------------------------------
  describe("/rewrite-prompt", () => {
    it("parses '/rewrite-prompt make it more cinematic'", () => {
      const args = simulateParse("/rewrite-prompt", "make it more cinematic");
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
  // 10. /isolate-vocals — isolate_vocals
  // -----------------------------------------------------------------------
  describe("/isolate-vocals", () => {
    it("parses '/isolate-vocals @voiceover-main'", () => {
      const args = simulateParse("/isolate-vocals", "@voiceover-main");
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
  // 11. Chat fallback commands: /generate, /trim, /trim-audio, /final
  // -----------------------------------------------------------------------
  describe("chat fallback commands", () => {
    it("/generate has no mcpTool or uiAction (falls to chat)", () => {
      const cmd = findCommand("/generate");
      expect(cmd.mcpTool).toBeUndefined();
      expect(cmd.uiAction).toBeUndefined();
    });

    it("/trim has no mcpTool or uiAction (falls to chat)", () => {
      const cmd = findCommand("/trim");
      expect(cmd.mcpTool).toBeUndefined();
      expect(cmd.uiAction).toBeUndefined();
    });

    it("/trim-audio has no mcpTool or uiAction (falls to chat)", () => {
      const cmd = findCommand("/trim-audio");
      expect(cmd.mcpTool).toBeUndefined();
      expect(cmd.uiAction).toBeUndefined();
    });

    it("/final has no mcpTool or uiAction (falls to chat)", () => {
      const cmd = findCommand("/final");
      expect(cmd.mcpTool).toBeUndefined();
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

    it("/copy-name has uiAction=copy_clipboard and parses @asset_id", () => {
      const cmd = findCommand("/copy-name");
      expect(cmd.uiAction).toBe("copy_clipboard");
      const args = simulateParse("/copy-name", "@hero-intro");
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
  });

  // -----------------------------------------------------------------------
  // 16. Full round-trip: /assign then /clear-slot
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
        name: "clear_slot",
        arguments: { project_slug: "test-proj", slot: "s01" },
      });
      expect(clearResult.isError).toBeFalsy();
      const clearParsed = parseResult(clearResult);
      expect((clearParsed.slots as Array<{ slug: string }>)[0].slug).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // 17. Full round-trip: upload → duplicate → rename → delete
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
});

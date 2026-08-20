import { describe, it, expect } from "vitest";
import {
  parseCommandArgs,
  normalizeApplySfxCommandArgs,
  normalizeSyncAudioCommandArgs,
  normalizeTimewarpCommandArgs,
  selectCommandForInput,
} from "../../../src/lib/command-registry.js";
import type { ServerCommand } from "../../../src/lib/command-registry.js";
import { executeUiAction } from "../../../src/lib/ui-actions.js";
import { getCanonicalCommands } from "./commands.js";

describe("slash command parse/normalize/dispatch", () => {
  const commands: ServerCommand[] = getCanonicalCommands() as ServerCommand[];

  function findCommand(name: string, rest = ""): ServerCommand {
    const cmd = selectCommandForInput(commands, name, rest);
    if (!cmd) throw new Error(`Command ${name} not found`);
    return cmd;
  }

  function simulateParse(commandStr: string, rest: string): Record<string, unknown> {
    const cmd = findCommand(commandStr, rest);
    return parseCommandArgs(rest, cmd.params);
  }


  describe("/timewarp", () => {
    it("normalizes the documented form into numeric MCP arguments", () => {
      const parsed = simulateParse("/timewarp", "a1 0-4.2s 1.5x");
      expect(normalizeTimewarpCommandArgs(parsed)).toEqual({
        asset_id: "a1",
        start_seconds: 0,
        end_seconds: 4.2,
        stretch_factor: 1.5,
      });
    });

    it("accepts an at-sign and colon timestamps", () => {
      const parsed = simulateParse("/timewarp", "@a1 0:01-0:04.2s 0.5x");
      expect(normalizeTimewarpCommandArgs(parsed)).toEqual({
        asset_id: "a1",
        start_seconds: 1,
        end_seconds: 4.2,
        stretch_factor: 0.5,
      });
    });

    it.each([
      "a1",
      "a1 0-4.2s",
      "a1 4.2-0s 1.5x",
      "a1 0-4.2s 1x",
      "a1 0-4.2s 1.5x extra",
    ])("rejects malformed arguments: %s", (rest) => {
      expect(() => normalizeTimewarpCommandArgs(simulateParse("/timewarp", rest))).toThrow();
    });
  });

  describe("/sync-audio", () => {
    it("normalizes transcript and numeric targets into nested MCP anchors", () => {
      const parsed = simulateParse(
        "/sync-audio",
        "@a1 3s=England; 6s=0:05.96",
      );
      expect(normalizeSyncAudioCommandArgs(parsed)).toEqual({
        asset_id: "a1",
        anchors: [
          { video_seconds: 3, audio_cue: "England" },
          { video_seconds: 6, audio_seconds: 5.96 },
        ],
      });
    });

    it.each([
      "a1",
      "a1 3s England",
      "a1 3s=England 6s=America",
      "a1 6s=America; 3s=England",
    ])("rejects malformed arguments: %s", (rest) => {
      expect(() => normalizeSyncAudioCommandArgs(simulateParse("/sync-audio", rest))).toThrow();
    });
  });

  describe("/apply-sfx", () => {
    it("normalizes a free-text effect into the structured MCP payload", () => {
      const parsed = simulateParse(
        "/apply-sfx",
        "@a1 2.5 whoosh fast cinematic transition whoosh",
      );
      expect(normalizeApplySfxCommandArgs(parsed)).toEqual({
        asset_id: "a1",
        sfx: [{
          timestamp: 2.5,
          type: "whoosh",
          description: "fast cinematic transition whoosh",
        }],
      });
    });

    it.each([
      "a1",
      "a1 later whoosh fast transition",
      "a1 2.5 whoosh",
    ])("rejects malformed arguments: %s", (rest) => {
      expect(() => normalizeApplySfxCommandArgs(
        simulateParse("/apply-sfx", rest),
      )).toThrow();
    });
  });

  describe("/audio-mix", () => {
    it("parses target, layer, and percentage volume", () => {
      expect(simulateParse(
        "/audio-mix",
        "@a1 @b1 30",
      )).toEqual({
        target_asset_id: "a1",
        layer_asset_id: "b1",
        volume: 30,
      });
    });
  });

  describe("/make-cover-song", () => {
    it("parses a media asset without optional direction", () => {
      expect(simulateParse(
        "/make-cover-song",
        "@a1",
      )).toEqual({
        asset_id: "a1",
      });
    });

    it("preserves a multi-word musical direction", () => {
      expect(simulateParse(
        "/make-cover-song",
        "@a1 punchier drums and sweeping strings",
      )).toEqual({
        asset_id: "a1",
        direction: "punchier drums and sweeping strings",
      });
    });

    it("accepts the legacy slash-command alias", () => {
      expect(simulateParse(
        "/replicate-song",
        "@a1",
      )).toEqual({
        asset_id: "a1",
      });
    });
  });

  describe("/splice", () => {
    it("parses two videos and a zero overlap", () => {
      expect(simulateParse(
        "/splice",
        "@a1 @a2 0",
      )).toEqual({
        first_asset_id: "a1",
        second_asset_id: "a2",
        overlap: 0,
      });
    });
  });

  describe("/scene-concat", () => {
    it("parses two videos with automatic audio alignment", () => {
      expect(simulateParse(
        "/scene-concat",
        "@a1 @a2",
      )).toEqual({
        first_asset_id: "a1",
        second_asset_id: "a2",
      });
    });

    it("parses an optional fixed transition duration", () => {
      expect(simulateParse(
        "/scene-concat",
        "@a1 @a2 0.25",
      )).toEqual({
        first_asset_id: "a1",
        second_asset_id: "a2",
        transition_seconds: 0.25,
      });
    });
  });

  describe("/remove-slot", () => {
    it("parses a stored timeline slot", () => {
      expect(simulateParse("/remove-slot", "@s02")).toEqual({ slot: "s02" });
    });
  });

  // -----------------------------------------------------------------------
  // 1. /download — download_video
  // -----------------------------------------------------------------------
  describe("/download", () => {
    it("parses '/download https://youtube.com/watch?v=abc'", () => {
      const args = simulateParse("/download", "https://youtube.com/watch?v=abc");
      expect(args.url).toBe("https://youtube.com/watch?v=abc");
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
  });

  // -----------------------------------------------------------------------
  // 4. /delete — delete_asset
  // -----------------------------------------------------------------------
  describe("/delete", () => {
    it("parses '/delete @outro-clip'", () => {
      const args = simulateParse("/delete", "@outro-clip");
      expect(args.asset_id).toBe("outro-clip");
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
  });

  // -----------------------------------------------------------------------
  // 6. /assign — assign_slot
  // -----------------------------------------------------------------------
  describe("/assign", () => {
    it("parses '/assign @a1 @s02'", () => {
      const args = simulateParse("/assign", "@a1 @s02");
      expect(args.asset_id).toBe("a1");
      expect(args.slot).toBe("s02");
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
  });

  // -----------------------------------------------------------------------
  // 8. /rewrite — rewrite_prompt (validation only, no API key)
  // -----------------------------------------------------------------------
  describe("/rewrite", () => {
    it("parses '/rewrite make it more cinematic'", () => {
      const args = simulateParse("/rewrite", "make it more cinematic");
      expect(args.prompt).toBe("make it more cinematic");
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
  });

  // -----------------------------------------------------------------------
  // 10. /vocals — isolate_vocals
  // -----------------------------------------------------------------------
  describe("/vocals", () => {
    it("parses '/vocals @voiceover-main'", () => {
      const args = simulateParse("/vocals", "@voiceover-main");
      expect(args.asset_id).toBe("voiceover-main");
    });
  });

  // -----------------------------------------------------------------------
  // 10b. /doctor — doctor (diagnose + fix)
  // -----------------------------------------------------------------------
  describe("/doctor", () => {
    it("parses '/doctor' (full project scan, no args)", () => {
      const args = simulateParse("/doctor", "");
      expect(args).toEqual({});
    });

    it("parses '/doctor @a1 fix' into asset_id + fix:true", () => {
      const args = simulateParse("/doctor", "@a1 fix");
      expect(args.asset_id).toBe("a1");
      expect(args.fix).toBe(true);
    });

    it("dispatches doctor via mcpTool with book_id auto-injected", () => {
      const cmd = findCommand("/doctor");
      expect(cmd.mcpTool?.tool).toBe("doctor");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
    });
  });

  // -----------------------------------------------------------------------
  // 11. Command dispatch wiring
  // -----------------------------------------------------------------------
  describe("command dispatch wiring", () => {
    it("/trim maps to trim_video with trim adapter", () => {
      const cmd = findCommand("/trim");
      expect(cmd.mcpTool?.tool).toBe("trim_video");
      expect(cmd.mcpTool?.adapter).toBe("trim");
    });

    it("/trim-video maps to trim_video with trim adapter", () => {
      const cmd = findCommand("/trim-video");
      expect(cmd.mcpTool?.tool).toBe("trim_video");
      expect(cmd.mcpTool?.adapter).toBe("trim");
    });

    it("/trim-audio maps to trim_audio with trim adapter", () => {
      const cmd = findCommand("/trim-audio");
      expect(cmd.mcpTool?.tool).toBe("trim_audio");
      expect(cmd.mcpTool?.adapter).toBe("trim");
    });

    it("/apply-cuts maps to apply_cuts with apply_cuts adapter", () => {
      const cmd = findCommand("/apply-cuts");
      expect(cmd.mcpTool?.tool).toBe("apply_cuts");
      expect(cmd.mcpTool?.adapter).toBe("apply_cuts");
    });

    it("/translate-subs maps to translate_subtitles with translate_subtitles adapter", () => {
      const cmd = findCommand("/translate-subs");
      expect(cmd.mcpTool?.tool).toBe("translate_subtitles");
      expect(cmd.mcpTool?.adapter).toBe("translate_subtitles");
    });

    it("/render-video and /render target render_video", () => {
      const renderVideoCmd = findCommand("/render-video");
      expect(renderVideoCmd.mcpTool?.tool).toBe("render_video");
      const renderCmd = findCommand("/render");
      expect(renderCmd.mcpTool?.tool).toBe("render_video");
    });

    it("/split is a composite notebook split command", () => {
      const cmd = findCommand("/split");
      expect(cmd.exposure).toBe("composite");
      expect(cmd.uiAction).toBeUndefined();
      expect(cmd.mcpTool).toBeUndefined();
    });

    it("parses '/split @a1 into 15s and the remaining'", () => {
      const args = simulateParse(
        "/split",
        "@a1 into 15s and the remaining",
      );
      expect(args.cell).toBe("a1");
      expect(args.split_spec).toBe("into 15s and the remaining");
    });

    it("passes keep/remove range phrasing through split_spec", () => {
      const keep = simulateParse("/split", "@a1 keep 0.03-0.11");
      expect(keep.cell).toBe("a1");
      expect(keep.split_spec).toBe("keep 0.03-0.11");
      const remove = simulateParse("/split", "@a1 remove 0:00.030-0:00.110");
      expect(remove.split_spec).toBe("remove 0:00.030-0:00.110");
    });

    it("keeps canonical-sequence splitting under /split-clip", () => {
      const args = simulateParse("/split-clip", "@clip-id 45");
      expect(args.clip_id).toBe("clip-id");
      expect(args.sequence_frame).toBe(45);
    });

    it("/final dispatches render_timeline via mcpTool", () => {
      const cmd = findCommand("/final");
      expect(cmd.mcpTool?.tool).toBe("render_timeline");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
      expect(cmd.uiAction).toBeUndefined();
    });

    it("parses and dispatches /inject-first-frame", () => {
      const args = simulateParse(
        "/inject-first-frame",
        "@final @b1 portrait",
      );
      expect(args).toEqual({
        target_asset_id: "final",
        image_asset_id: "b1",
        orientation: "portrait",
      });
      const cmd = findCommand("/inject-first-frame");
      expect(cmd.mcpTool?.tool).toBe("inject_first_frame");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
    });

    it("parses and dispatches /extend-audio for the 6.05s to 15s workflow", () => {
      const args = simulateParse(
        "/extend-audio",
        "@c1 15",
      );
      expect(args).toEqual({
        asset_id: "c1",
        target_duration_seconds: 15,
      });
      const cmd = findCommand("/extend-audio");
      expect(cmd.mcpTool?.tool).toBe("extend_audio_asset");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
    });

    it("maps /make-cover-song to make_cover_song", () => {
      const cmd = findCommand("/make-cover-song");
      expect(cmd.mcpTool?.tool).toBe("make_cover_song");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
    });

    it("parses a trailing free-text /extend-audio continuation prompt", () => {
      const args = simulateParse(
        "/extend-audio",
        "@c1 15 add outro music",
      );
      expect(args).toEqual({
        asset_id: "c1",
        target_duration_seconds: 15,
        continuation_prompt: "add outro music",
      });
    });

    it("parses /remove-sound with a multi-word sound description", () => {
      const args = simulateParse(
        "/remove-sound",
        "@a1 horse neighing",
      );
      expect(args).toEqual({
        asset_id: "a1",
        sound: "horse neighing",
      });
      const cmd = findCommand("/remove-sound");
      expect(cmd.mcpTool?.tool).toBe("remove_sound");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
    });

    it("passes a parenthesized /extend-audio prompt through for the server to unwrap", () => {
      const args = simulateParse(
        "/extend-audio",
        "@c1 15 (add outro music)",
      );
      expect(args).toEqual({
        asset_id: "c1",
        target_duration_seconds: 15,
        continuation_prompt: "(add outro music)",
      });
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
  // 13. Viewer commands
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
      it(`${name} has uiAction=${action}`, () => {
        const cmd = findCommand(name);
        expect(cmd.uiAction).toBe(action);
      });
    }

    it("/files parses position number", () => {
      const args = simulateParse("/files", "3");
      expect(args.position).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // 14b. /qart — create_qart
  // -----------------------------------------------------------------------
  describe("/qart", () => {
    it("is registered with create_qart mcpTool", () => {
      const cmd = findCommand("/qart");
      expect(cmd.mcpTool?.tool).toBe("create_qart");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
      expect(cmd.params.map((p) => p.name)).toEqual(["image_ref", "value"]);
    });

    it("parses '/qart @b1 https://example.com/path'", () => {
      const args = simulateParse("/qart", "@b1 https://example.com/path");
      expect(args.image_ref).toBe("b1");
      expect(args.value).toBe("https://example.com/path");
    });

    it("parses multi-token value into remaining string", () => {
      const args = simulateParse("/qart", "@b2 hello world qr text");
      expect(args.image_ref).toBe("b2");
      expect(args.value).toBe("hello world qr text");
    });
  });

  // -----------------------------------------------------------------------
  // 14c. /qrbtf — create_qrbtf
  // -----------------------------------------------------------------------
  describe("/qrbtf", () => {
    it("is registered with create_qrbtf mcpTool", () => {
      const cmd = findCommand("/qrbtf");
      expect(cmd.mcpTool?.tool).toBe("create_qrbtf");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
      expect(cmd.params.map((p) => p.name)).toEqual(["value", "style"]);
    });

    it("parses '/qrbtf https://example.com normal'", () => {
      const args = simulateParse("/qrbtf", "https://example.com normal");
      expect(args.value).toBe("https://example.com");
      expect(args.style).toBe("normal");
    });

    it("parses '/qrbtf https://example.com' without style", () => {
      const args = simulateParse("/qrbtf", "https://example.com");
      expect(args.value).toBe("https://example.com");
      expect(args.style).toBeUndefined();
    });
  });

  describe("/invert", () => {
    it("finds the command config", () => {
      const cmd = findCommand("/invert");
      expect(cmd).toBeDefined();
      expect(cmd.mcpTool?.tool).toBe("invert_image");
    });

    it("parses '/invert @b1'", () => {
      const args = simulateParse("/invert", "@b1");
      expect(args.asset_id).toBe("b1");
    });
  });

  describe("/concat", () => {
    it("is registered with concat_images mcpTool", () => {
      const cmd = findCommand("/concat");
      expect(cmd.mcpTool?.tool).toBe("concat_images");
      expect(cmd.mcpTool?.autoInject).toContain("book_id");
      expect(cmd.params.map((p) => p.name)).toEqual(["image_refs"]);
      expect(cmd.params[0]?.type).toBe("string[]");
    });

    it("parses one or two image refs", () => {
      expect(simulateParse("/concat", "@b1 @b2").image_refs).toEqual(["b1", "b2"]);
      expect(simulateParse("/concat", "@b1").image_refs).toEqual(["b1"]);
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

    it("/archive parses an asset id and optional topic tokens", () => {
      const args = simulateParse("/archive", "@a1 ai interview");
      expect(args.asset_id).toBe("a1");
      expect(args.topics).toEqual(["ai", "interview"]);
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
  // 23. /folder with different inputs
  // -----------------------------------------------------------------------
  describe("/folder different inputs", () => {
    it("parses '/folder @a1'", () => {
      const args = simulateParse("/folder", "@a1");
      expect(args.asset_id).toBe("a1");
    });
  });

  // -----------------------------------------------------------------------
  // 32. /vocals — different audio formats for aud- assets
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // 41. parseCommandArgs — additional edge cases
  // -----------------------------------------------------------------------
  describe("parseCommandArgs additional edge cases", () => {
    it("/render parses asset_id from '/render @a1'", () => {
      const args = simulateParse("/render", "@a1");
      expect(args.asset_id).toBe("a1");
    });

    it("/vocals parses asset_id", () => {
      const args = simulateParse("/vocals", "@c1");
      expect(args.asset_id).toBe("c1");
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
      expect(args.position).toBe(99);
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
      const args = simulateParse("/assign", "a1 s02");
      expect(args.asset_id).toBe("a1");
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
      const args = simulateParse("/copy", "a1");
      expect(args.asset_id).toBe("a1");
    });

    it("/history with vid- prefixed asset", () => {
      const args = simulateParse("/history", "@a1");
      expect(args.asset_id).toBe("a1");
    });

    it("/open with aud- prefixed asset", () => {
      const args = simulateParse("/open", "@c1");
      expect(args.asset_id).toBe("c1");
    });
  });

  // -----------------------------------------------------------------------
  // Render settings commands — command definitions
  // -----------------------------------------------------------------------
  describe("render settings commands", () => {
    it("/subs has uiAction=settings_subs and field+value params", () => {
      const cmd = findCommand("/subs");
      expect(cmd.uiAction).toBe("settings_subs");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("field");
      expect(names).toContain("value");
      expect(cmd.params.find((p) => p.name === "field")!.required).toBe(true);
      expect(cmd.params.find((p) => p.name === "value")!.required).toBe(false);
    });

    it("/audio has uiAction=settings_audio and field+value params", () => {
      const cmd = findCommand("/audio");
      expect(cmd.uiAction).toBe("settings_audio");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("field");
      expect(names).toContain("value");
      expect(cmd.params.find((p) => p.name === "field")!.required).toBe(true);
      expect(cmd.params.find((p) => p.name === "value")!.required).toBe(false);
    });

    it("/bg has uiAction=settings_bg and mode param", () => {
      const cmd = findCommand("/bg");
      expect(cmd.uiAction).toBe("settings_bg");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("mode");
      expect(cmd.params.find((p) => p.name === "mode")!.required).toBe(true);
    });

    it("/osg has uiAction=open_osg with required asset_id + optional image params", () => {
      const cmd = findCommand("/osg");
      expect(cmd.uiAction).toBe("open_osg");
      const names = cmd.params.map((p) => p.name);
      expect(names).toContain("asset_id");
      expect(names).toContain("image");
      expect(cmd.params.find((p) => p.name === "asset_id")!.required).toBe(true);
      expect(cmd.params.find((p) => p.name === "image")!.required).toBe(false);
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
    it("/osg @a1 parses the video asset id", () => {
      const args = simulateParse("/osg", "@a1");
      expect(args.asset_id).toBe("a1");
      expect(args.image).toBeUndefined();
    });

    it("/osg @a1 @b2 parses both asset ids", () => {
      const args = simulateParse("/osg", "@a1 @b2");
      expect(args.asset_id).toBe("a1");
      expect(args.image).toBe("b2");
    });
  });

  // -----------------------------------------------------------------------
  // Render settings executeUiAction dispatch
  // -----------------------------------------------------------------------
  describe("render settings executeUiAction dispatch", () => {
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

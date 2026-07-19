import { describe, it, expect } from "vitest";
import {
  parseCommandArgs,
  filterCommandsByMountKeys,
  normalizeApplySfxCommandArgs,
  normalizeKeywordCommandArgs,
  normalizeQrOutroCommandArgs,
  normalizeSyncAudioCommandArgs,
  normalizeTimewarpCommandArgs,
  selectCommandForInput,
} from "./command-registry.js";
import type { CommandParam, ServerCommand } from "./command-registry.js";

// ---------------------------------------------------------------------------
// parseCommandArgs
// ---------------------------------------------------------------------------

describe("parseCommandArgs", () => {
  it("returns empty object for empty rest string", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("", params)).toEqual({});
  });

  it("returns empty object when no params defined", () => {
    expect(parseCommandArgs("some text here", [])).toEqual({});
  });

  it("parses single string param", () => {
    const params: CommandParam[] = [
      { name: "url", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("https://example.com", params)).toEqual({
      url: "https://example.com",
    });
  });

  it("strips @ prefix from asset references", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@hero-intro", params)).toEqual({
      asset_id: "hero-intro",
    });
  });

  it("parses two params from space-separated tokens", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "slot", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@vid-clip @s02", params)).toEqual({
      asset_id: "vid-clip",
      slot: "s02",
    });
  });

  it("last string param gets all remaining tokens joined", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "new_name", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@photo sunset beach photo", params)).toEqual({
      asset_id: "photo",
      new_name: "sunset beach photo",
    });
  });

  it("parses /speed style asset + string args", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "speed", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@vid-x 8.32s", params)).toEqual({
      asset_id: "vid-x",
      speed: "8.32s",
    });
  });

  it("parses /archive-restore style trailing string[] of ids", () => {
    const params: CommandParam[] = [
      { name: "archive_ids", type: "string[]", required: true, description: "" },
    ];
    expect(parseCommandArgs("arc-abc123 arc-def456", params)).toEqual({
      archive_ids: ["arc-abc123", "arc-def456"],
    });
  });

  it("parses /say style asset + trailing text", () => {
    const params: CommandParam[] = [
      { name: "voice_id", type: "string", required: true, description: "" },
      { name: "text", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("12345 hello there everyone", params)).toEqual({
      voice_id: "12345",
      text: "hello there everyone",
    });
  });

  it("parses /audio-set style ref + field + number", () => {
    const params: CommandParam[] = [
      { name: "audio_ref", type: "string", required: true, description: "" },
      { name: "field", type: "string", required: true, description: "" },
      { name: "value", type: "number", required: true, description: "" },
    ];
    expect(parseCommandArgs("@aud-music volume 80", params)).toEqual({
      audio_ref: "aud-music",
      field: "volume",
      value: 80,
    });
  });

  it("parses /audio-mix target, layer, and percentage volume", () => {
    const params: CommandParam[] = [
      { name: "target_asset_id", type: "string", required: true, description: "" },
      { name: "layer_asset_id", type: "string", required: true, description: "" },
      { name: "volume", type: "number", required: true, description: "" },
    ];
    expect(parseCommandArgs("@vid-main @aud-music 30", params)).toEqual({
      target_asset_id: "vid-main",
      layer_asset_id: "aud-music",
      volume: 30,
    });
  });

  it("parses /splice assets and zero overlap", () => {
    const params: CommandParam[] = [
      { name: "first_asset_id", type: "string", required: true, description: "" },
      { name: "second_asset_id", type: "string", required: true, description: "" },
      { name: "overlap", type: "number", required: true, description: "" },
    ];
    expect(parseCommandArgs("@vid-first @vid-second 0", params)).toEqual({
      first_asset_id: "vid-first",
      second_asset_id: "vid-second",
      overlap: 0,
    });
  });

  it("parses /split style optional trailing number left absent", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "chunk_a_end", type: "number", required: true, description: "" },
      { name: "chunk_b_start", type: "number", required: false, description: "" },
    ];
    expect(parseCommandArgs("@vid-x 10", params)).toEqual({
      asset_id: "vid-x",
      chunk_a_end: 10,
    });
  });

  it("strips 'to' connector from last param", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "new_name", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@product-shot to product-hero", params)).toEqual({
      asset_id: "product-shot",
      new_name: "product-hero",
    });
  });

  it("does not strip 'to' if it's the only remaining token", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "new_name", type: "string", required: true, description: "" },
    ];
    // "to" is the only token for new_name — keep it as-is
    expect(parseCommandArgs("@img to", params)).toEqual({
      asset_id: "img",
      new_name: "to",
    });
  });

  it("strips @ from last param if it starts with @", () => {
    const params: CommandParam[] = [
      { name: "name", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@some-slug", params)).toEqual({
      name: "some-slug",
    });
  });

  it("handles three params: asset + start + end", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "start", type: "string", required: false, description: "" },
      { name: "end", type: "string", required: false, description: "" },
    ];
    expect(parseCommandArgs("@hero-intro 0:05 0:12", params)).toEqual({
      asset_id: "hero-intro",
      start: "0:05",
      end: "0:12",
    });
  });

  it("handles fewer tokens than params", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "start", type: "string", required: false, description: "" },
      { name: "end", type: "string", required: false, description: "" },
    ];
    expect(parseCommandArgs("@hero-intro", params)).toEqual({
      asset_id: "hero-intro",
    });
  });

  it("handles prompt-style single string param with multi-word input", () => {
    const params: CommandParam[] = [
      { name: "prompt", type: "string", required: true, description: "" },
    ];
    expect(
      parseCommandArgs("video of a dog on a skateboard", params),
    ).toEqual({
      prompt: "video of a dog on a skateboard",
    });
  });

  it("parses number param from token", () => {
    const params: CommandParam[] = [
      { name: "position", type: "number", required: true, description: "" },
    ];
    expect(parseCommandArgs("3", params)).toEqual({ position: 3 });
  });

  it("parses decimal number param from token", () => {
    const params: CommandParam[] = [
      { name: "boost", type: "number", required: true, description: "" },
    ];
    expect(parseCommandArgs("1.2", params)).toEqual({ boost: 1.2 });
  });

  it("parses boolean param from token", () => {
    const params: CommandParam[] = [
      { name: "full", type: "boolean", required: true, description: "" },
    ];
    expect(parseCommandArgs("true", params)).toEqual({ full: true });
  });

  it("treats 'fix' as a truthy boolean token (e.g. /doctor @x fix)", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: false, description: "" },
      { name: "fix", type: "boolean", required: false, description: "" },
    ];
    expect(parseCommandArgs("@vid-florida fix", params)).toEqual({
      asset_id: "vid-florida",
      fix: true,
    });
    // Bare scan: no asset, no fix.
    expect(parseCommandArgs("@vid-florida", params)).toEqual({ asset_id: "vid-florida" });
  });

  // -----------------------------------------------------------------------
  // Freeform-style edge cases
  // -----------------------------------------------------------------------

  it("URL with query params stays intact as single token", () => {
    const params: CommandParam[] = [
      { name: "url", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("https://youtube.com/watch?v=abc&t=30", params)).toEqual({
      url: "https://youtube.com/watch?v=abc&t=30",
    });
  });

  it("URL without protocol prefix stays intact", () => {
    const params: CommandParam[] = [
      { name: "url", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("youtube.com/watch?v=abc", params)).toEqual({
      url: "youtube.com/watch?v=abc",
    });
  });

  it("slot ref @s01 strips @ prefix", () => {
    const params: CommandParam[] = [
      { name: "slot", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@s01", params)).toEqual({ slot: "s01" });
  });

  it("handles quoted string as single last param", () => {
    const params: CommandParam[] = [
      { name: "prompt", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs('"make it more cinematic"', params)).toEqual({
      prompt: '"make it more cinematic"',
    });
  });

  it("handles asset + multi-word prompt (two string params)", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
      { name: "prompt", type: "string", required: true, description: "" },
    ];
    expect(parseCommandArgs("@vid-intro a cinematic sunset over mountains", params)).toEqual({
      asset_id: "vid-intro",
      prompt: "a cinematic sunset over mountains",
    });
  });

  it("handles URL + two timestamps + boolean (4 params)", () => {
    const params: CommandParam[] = [
      { name: "url", type: "string", required: true, description: "" },
      { name: "start_time", type: "string", required: false, description: "" },
      { name: "end_time", type: "string", required: false, description: "" },
      { name: "full", type: "boolean", required: false, description: "" },
    ];
    expect(parseCommandArgs("https://example.com/vid 1:30 2:45", params)).toEqual({
      url: "https://example.com/vid",
      start_time: "1:30",
      end_time: "2:45",
    });
  });

  it("parses trailing boolean after omitted optional strings", () => {
    const params: CommandParam[] = [
      { name: "url", type: "string", required: true, description: "" },
      { name: "start_time", type: "string", required: false, description: "" },
      { name: "end_time", type: "string", required: false, description: "" },
      { name: "full", type: "boolean", required: false, description: "" },
    ];
    expect(parseCommandArgs("https://example.com/vid full", params)).toEqual({
      url: "https://example.com/vid",
      full: true,
    });
  });

  it("rest-array param collects remaining tokens with @ stripped", () => {
    const params: CommandParam[] = [
      { name: "source_asset_id", type: "string", required: true, description: "" },
      { name: "character_asset_ids", type: "string[]", required: false, description: "" },
    ];
    expect(
      parseCommandArgs("@vid-input @char-naval @char-nivi @char-claude", params),
    ).toEqual({
      source_asset_id: "vid-input",
      character_asset_ids: ["char-naval", "char-nivi", "char-claude"],
    });
  });

  it("rest-array param is omitted when no extra tokens", () => {
    const params: CommandParam[] = [
      { name: "source_asset_id", type: "string", required: true, description: "" },
      { name: "character_asset_ids", type: "string[]", required: false, description: "" },
    ];
    expect(parseCommandArgs("@vid-input", params)).toEqual({
      source_asset_id: "vid-input",
    });
  });

  it("extra tokens beyond param count are ignored", () => {
    const params: CommandParam[] = [
      { name: "asset_id", type: "string", required: true, description: "" },
    ];
    // Only 1 param but 3 tokens — only first matters (not last-string-param)
    expect(parseCommandArgs("@vid-foo extra stuff", params)).toEqual({
      asset_id: "vid-foo extra stuff",
    });
  });
});

describe("normalizeQrOutroCommandArgs", () => {
  it("maps every image to the ordered QR list", () => {
    expect(normalizeQrOutroCommandArgs([
      "@img-qr-zero",
      "@img-qr-one",
      "@img-qr-two",
      "16:9",
    ])).toEqual({
      qr_image_slugs: ["img-qr-zero", "img-qr-one", "img-qr-two"],
      aspect_ratio: "16:9",
    });
  });

  it("accepts optional inputs in either order", () => {
    expect(normalizeQrOutroCommandArgs([
      "img-qr-one",
      "9:16",
      "img-qr-two",
    ])).toEqual({
      qr_image_slugs: ["img-qr-one", "img-qr-two"],
      aspect_ratio: "9:16",
    });
  });

  it("omits optional values when absent", () => {
    expect(normalizeQrOutroCommandArgs(["img-qr"])).toEqual({
      qr_image_slugs: ["img-qr"],
    });
  });

  it("rejects invalid QR counts", () => {
    expect(() => normalizeQrOutroCommandArgs(["aud-hit"])).toThrow();
    expect(() => normalizeQrOutroCommandArgs([
      "img-1",
      "img-2",
      "img-3",
      "img-4",
      "img-5",
    ])).toThrow();
  });

  it("rejects audio, duplicate aspect ratios, and unknown tokens", () => {
    expect(() => normalizeQrOutroCommandArgs([
      "img-qr",
      "aud-one",
    ])).toThrow();
    expect(() => normalizeQrOutroCommandArgs([
      "img-qr",
      "16:9",
      "1:1",
    ])).toThrow();
    expect(() => normalizeQrOutroCommandArgs([
      "img-qr",
      "wide",
    ])).toThrow();
  });
});

describe("normalizeApplySfxCommandArgs", () => {
  it("maps slash arguments to one structured SFX cue", () => {
    expect(normalizeApplySfxCommandArgs({
      asset_id: "@vid-intro",
      timestamp: "1:02.5",
      type: " whoosh ",
      description: " fast cinematic transition whoosh ",
    })).toEqual({
      asset_id: "vid-intro",
      sfx: [{
        timestamp: 62.5,
        type: "whoosh",
        description: "fast cinematic transition whoosh",
      }],
    });
  });

  it.each([
    [{ timestamp: 1, type: "whoosh", description: "fast" }, "video asset"],
    [{ asset_id: "aud-intro", timestamp: 1, type: "whoosh", description: "fast" }, "vid-*"],
    [{ asset_id: "vid-intro", timestamp: "later", type: "whoosh", description: "fast" }, "timestamp"],
    [{ asset_id: "vid-intro", timestamp: -1, type: "whoosh", description: "fast" }, "timestamp"],
    [{ asset_id: "vid-intro", timestamp: 1, description: "fast" }, "effect type"],
    [{ asset_id: "vid-intro", timestamp: 1, type: "whoosh" }, "effect description"],
  ])("rejects malformed arguments: %o", (args, message) => {
    expect(() => normalizeApplySfxCommandArgs(args)).toThrow(message);
  });
});

describe("normalizeKeywordCommandArgs", () => {
  it("maps transcript words to explicit keyword input", () => {
    expect(normalizeKeywordCommandArgs({
      asset_id: "vid-intro",
      inputs: ["Multicultural", "Revolution", "Success"],
    })).toEqual({
      asset_id: "vid-intro",
      keywords: ["Multicultural", "Revolution", "Success"],
    });
  });

  it("keeps automatic mode when no words are supplied", () => {
    expect(normalizeKeywordCommandArgs({ asset_id: "@vid-intro" })).toEqual({
      asset_id: "vid-intro",
    });
  });

  it("supports the legacy on, count, and linger syntax", () => {
    expect(normalizeKeywordCommandArgs({
      asset_id: "vid-intro",
      inputs: ["on", "3", "2.4"],
    })).toEqual({
      asset_id: "vid-intro",
      enabled: true,
      max_keywords: 3,
      linger_seconds: 2.4,
    });
  });

  it("supports turning keyword graphics off", () => {
    expect(normalizeKeywordCommandArgs({
      asset_id: "vid-intro",
      inputs: ["off"],
    })).toEqual({
      asset_id: "vid-intro",
      enabled: false,
    });
  });

  it.each([
    [{ asset_id: "img-wrong", inputs: ["Success"] }, "vid-*"],
    [{ asset_id: "vid-intro", inputs: ["on", "0"] }, "integer"],
    [{ asset_id: "vid-intro", inputs: ["on", "3", "5.1"] }, "between"],
    [{ asset_id: "vid-intro", inputs: ["off", "extra"] }, "extra"],
  ])("rejects invalid input %#", (args, message) => {
    expect(() => normalizeKeywordCommandArgs(args)).toThrow(message);
  });
});

describe("normalizeTimewarpCommandArgs", () => {
  it.each([
    ["vid-clip", "0-4.2s", "1.5x", 0, 4.2, 1.5],
    ["@vid-clip", "0s-4.2s", "0.5", 0, 4.2, 0.5],
    ["vid-clip", "0:30-1:02.5", "2x", 30, 62.5, 2],
    ["vid-clip", "1:00:00-1:00:04.2s", "4X", 3600, 3604.2, 4],
  ])("normalizes asset, range, and factor %#", (
    assetId,
    range,
    factor,
    startSeconds,
    endSeconds,
    stretchFactor,
  ) => {
    expect(normalizeTimewarpCommandArgs({
      asset_id: String(assetId),
      range: String(range),
      factor: String(factor),
    })).toEqual({
      asset_id: "vid-clip",
      start_seconds: startSeconds,
      end_seconds: endSeconds,
      stretch_factor: stretchFactor,
    });
  });

  it.each([
    [{}, "video asset"],
    [{ asset_id: "img-wrong", range: "0-2", factor: "1.5x" }, "vid-*"],
    [{ asset_id: "vid-clip", range: "bad", factor: "1.5x" }, "range"],
    [{ asset_id: "vid-clip", range: "2-1", factor: "1.5x" }, "before"],
    [{ asset_id: "vid-clip", range: "0-2", factor: "nope" }, "factor"],
    [{ asset_id: "vid-clip", range: "0-2", factor: "1x" }, "no-op"],
    [{ asset_id: "vid-clip", range: "0-2", factor: "5x" }, "between"],
    [{ asset_id: "vid-clip", range: "0-2", factor: "1.5x extra" }, "factor"],
  ])("rejects malformed input %#", (args, message) => {
    expect(() => normalizeTimewarpCommandArgs(args)).toThrow(message);
  });
});

describe("normalizeSyncAudioCommandArgs", () => {
  it("normalizes transcript cue anchors from the documented form", () => {
    expect(normalizeSyncAudioCommandArgs({
      asset_id: "@vid-frankenstein",
      mappings: "3s=England; 6s=America",
    })).toEqual({
      asset_id: "vid-frankenstein",
      anchors: [
        { video_seconds: 3, audio_cue: "England" },
        { video_seconds: 6, audio_cue: "America" },
      ],
    });
  });

  it("accepts colon and decimal times and strips optional cue quotes", () => {
    expect(normalizeSyncAudioCommandArgs({
      asset_id: "vid-frankenstein",
      mappings: "0:03=\"British guy\"; 0:06.5s='American guy'; 8.25=0:09.75",
    })).toEqual({
      asset_id: "vid-frankenstein",
      anchors: [
        { video_seconds: 3, audio_cue: "British guy" },
        { video_seconds: 6.5, audio_cue: "American guy" },
        { video_seconds: 8.25, audio_seconds: 9.75 },
      ],
    });
  });

  it("treats quoted and non-timestamp digit-leading targets as cues", () => {
    expect(normalizeSyncAudioCommandArgs({
      asset_id: "vid-frankenstein",
      mappings: "3s=\"10\"; 6s=10 Downing Street; 9s=4minutes",
    })).toEqual({
      asset_id: "vid-frankenstein",
      anchors: [
        { video_seconds: 3, audio_cue: "10" },
        { video_seconds: 6, audio_cue: "10 Downing Street" },
        { video_seconds: 9, audio_cue: "4minutes" },
      ],
    });
  });

  it.each([
    [{}, "video asset"],
    [{ asset_id: "img-wrong", mappings: "3s=England" }, "vid-*"],
    [{ asset_id: "vid-clip" }, "at least one"],
    [{ asset_id: "vid-clip", mappings: "3s England" }, "mapping"],
    [{ asset_id: "vid-clip", mappings: "3s=England=America" }, "mapping"],
    [{ asset_id: "vid-clip", mappings: "bad=England" }, "timestamp"],
    [{ asset_id: "vid-clip", mappings: "3s=" }, "mapping"],
    [{ asset_id: "vid-clip", mappings: "3s=England;" }, "mapping"],
    [{ asset_id: "vid-clip", mappings: "6s=America; 3s=England" }, "increasing"],
    [{ asset_id: "vid-clip", mappings: "3s=England; 3s=America" }, "increasing"],
    [{ asset_id: "vid-clip", mappings: "3s=\"England'" }, "quotes"],
  ])("rejects malformed input %#", (args, message) => {
    expect(() => normalizeSyncAudioCommandArgs(args)).toThrow(message);
  });
});

describe("selectCommandForInput", () => {
  const makeCmd = (command: string, params: CommandParam[]): ServerCommand => ({
    command,
    description: "",
    category: "action",
    icon: "",
    size: "default",
    variant: "default",
    chevron: "right",
    params,
  });

  it("prefers asset-first duplicate for @ asset input", () => {
    const assetCmd = makeCmd("/rewrite", [
      { name: "asset_id", type: "string", required: true, description: "" },
    ]);
    const promptCmd = makeCmd("/rewrite", [
      { name: "prompt", type: "string", required: true, description: "" },
    ]);
    expect(selectCommandForInput([assetCmd, promptCmd], "/rewrite", "@script-one")).toBe(assetCmd);
  });

  it("prefers non-asset duplicate for plain text input", () => {
    const assetCmd = makeCmd("/rewrite", [
      { name: "asset_id", type: "string", required: true, description: "" },
    ]);
    const promptCmd = makeCmd("/rewrite", [
      { name: "prompt", type: "string", required: true, description: "" },
    ]);
    expect(selectCommandForInput([assetCmd, promptCmd], "/rewrite", "make it cinematic")).toBe(promptCmd);
  });
});

// ---------------------------------------------------------------------------
// filterCommandsByMountKeys
// ---------------------------------------------------------------------------

describe("filterCommandsByMountKeys", () => {
  const makeCmd = (
    command: string,
    onMount?: string[],
  ): ServerCommand => ({
    command,
    description: "",
    category: "action",
    icon: "",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [],
    onMount,
  });

  it("includes commands with no onMount requirement", () => {
    const cmds = [makeCmd("/generate"), makeCmd("/download")];
    const result = filterCommandsByMountKeys(cmds, new Set());
    expect(result).toHaveLength(2);
  });

  it("excludes commands when their mount key is not active", () => {
    const cmds = [makeCmd("/generate"), makeCmd("/original", ["viewer"])];
    const result = filterCommandsByMountKeys(cmds, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].command).toBe("/generate");
  });

  it("includes commands when their mount key is active", () => {
    const cmds = [makeCmd("/generate"), makeCmd("/original", ["viewer"])];
    const result = filterCommandsByMountKeys(cmds, new Set(["viewer"]));
    expect(result).toHaveLength(2);
  });

  it("requires all mount keys to be active (AND logic)", () => {
    const cmds = [makeCmd("/multi", ["viewer", "editor"])];
    const result = filterCommandsByMountKeys(cmds, new Set(["viewer"]));
    expect(result).toHaveLength(0);
  });

  it("passes when all mount keys are active", () => {
    const cmds = [makeCmd("/multi", ["viewer", "editor"])];
    const result = filterCommandsByMountKeys(
      cmds,
      new Set(["viewer", "editor"]),
    );
    expect(result).toHaveLength(1);
  });

  it("treats empty onMount array as no requirement", () => {
    const cmds = [makeCmd("/test", [])];
    const result = filterCommandsByMountKeys(cmds, new Set());
    expect(result).toHaveLength(1);
  });
});

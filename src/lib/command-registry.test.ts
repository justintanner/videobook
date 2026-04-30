import { describe, it, expect } from "vitest";
import {
  parseCommandArgs,
  filterCommandsByMountKeys,
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
    expect(parseCommandArgs("3", params)).toEqual({ position: "3" });
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

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

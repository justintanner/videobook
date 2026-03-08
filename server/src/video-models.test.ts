import { describe, it, expect } from "vitest";
import {
  extractLastSettingsPerModel,
  buildModelOption,
  VIDEO_MODELS,
} from "./video-models.js";
import type { ActionLogEntry } from "./video-models.js";

// ---------------------------------------------------------------------------
// extractLastSettingsPerModel
// ---------------------------------------------------------------------------

describe("extractLastSettingsPerModel", () => {
  it("returns empty map for empty log", () => {
    const result = extractLastSettingsPerModel([]);
    expect(result.size).toBe(0);
  });

  it("extracts settings from a single kling30 log entry, stripping project_slug", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "abc123",
        action: "tool-generate-kling30-video",
        payload: { project_slug: "my-proj", prompt: "sunset", mode: "pro", duration: "10" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.get("generate_kling30_video")).toEqual({
      prompt: "sunset",
      mode: "pro",
      duration: "10",
    });
  });

  it("uses first (newest) entry per model since git log is newest-first", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "newer",
        action: "tool-generate-kling30-video",
        payload: { prompt: "newest prompt", mode: "std" },
        date: "2026-03-08T02:00:00Z",
      },
      {
        hash: "older",
        action: "tool-generate-kling30-video",
        payload: { prompt: "older prompt", mode: "pro" },
        date: "2026-03-08T01:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.get("generate_kling30_video")).toEqual({
      prompt: "newest prompt",
      mode: "std",
    });
  });

  it("handles multiple different models independently", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "a1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "kling prompt", duration: "8" },
        date: "2026-03-08T00:00:00Z",
      },
      {
        hash: "a2",
        action: "tool-generate-seedance-video",
        payload: { prompt: "seedance prompt", resolution: "1080p" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(2);
    expect(result.get("generate_kling30_video")).toEqual({ prompt: "kling prompt", duration: "8" });
    expect(result.get("generate_seedance_video")).toEqual({ prompt: "seedance prompt", resolution: "1080p" });
  });

  it("ignores non-video-gen action entries", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "s1",
        action: "tool-sleep",
        payload: { duration: 5000 },
        date: "2026-03-08T00:00:00Z",
      },
      {
        hash: "s2",
        action: "tool-asset-manifest",
        payload: { project_slug: "default" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(0);
  });

  it("skips entries with string payloads", () => {
    const log: ActionLogEntry[] = [
      {
        hash: "s1",
        action: "tool-generate-kling30-video",
        payload: "some string payload",
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(0);
  });

  it("handles all 5 video model action names correctly", () => {
    const actionNames = [
      "tool-generate-kling30-video",
      "tool-generate-veo-video",
      "tool-extend-veo-video",
      "tool-generate-seedance-video",
      "tool-generate-grok-imagine-video",
    ];
    const log: ActionLogEntry[] = actionNames.map((action, i) => ({
      hash: `h${i}`,
      action,
      payload: { prompt: `prompt-${i}` },
      date: "2026-03-08T00:00:00Z",
    }));
    const result = extractLastSettingsPerModel(log);
    expect(result.size).toBe(5);
    expect(result.has("generate_kling30_video")).toBe(true);
    expect(result.has("generate_veo_video")).toBe(true);
    expect(result.has("extend_veo_video")).toBe(true);
    expect(result.has("generate_seedance_video")).toBe(true);
    expect(result.has("generate_grok_imagine_video")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildModelOption — history integration
// ---------------------------------------------------------------------------

describe("buildModelOption history integration", () => {
  const kling = VIDEO_MODELS.kling30;
  const seedance = VIDEO_MODELS.seedance;

  it("history params fill in as defaults when router params are empty", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "old prompt", mode: "pro", duration: "12" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("kling30", kling, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("old prompt");
    expect(option.prefilled_values.mode).toBe("pro");
    expect(option.prefilled_values.duration).toBe("12");
  });

  it("router params take precedence over history params", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "old prompt", mode: "pro", duration: "12" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const routerParams = { mode: "std", duration: "5" };
    const option = buildModelOption("kling30", kling, routerParams, [], history);
    // Router params win
    expect(option.prefilled_values.mode).toBe("std");
    expect(option.prefilled_values.duration).toBe("5");
    // History fills in where router didn't specify
    expect(option.prefilled_values.prompt).toBe("old prompt");
  });

  it("history for model X does not leak into model Y", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-kling30-video",
        payload: { prompt: "kling prompt", mode: "pro" },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance", seedance, {}, [], history);
    // Should not have kling's prompt or mode
    expect(option.prefilled_values.prompt).toBeUndefined();
    // mode is not in seedance's params at all, so it shouldn't appear
    expect(option.prefilled_values).not.toHaveProperty("mode");
  });

  it("history params filtered by model's allowedParams", () => {
    const history: ActionLogEntry[] = [
      {
        hash: "h1",
        action: "tool-generate-seedance-video",
        payload: { prompt: "test", resolution: "1080p", sound: true },
        date: "2026-03-08T00:00:00Z",
      },
    ];
    const option = buildModelOption("seedance", seedance, {}, [], history);
    expect(option.prefilled_values.prompt).toBe("test");
    expect(option.prefilled_values.resolution).toBe("1080p");
    // sound is not in seedance's allowed params
    expect(option.prefilled_values).not.toHaveProperty("sound");
  });
});

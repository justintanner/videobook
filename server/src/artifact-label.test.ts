import { describe, expect, it } from "vitest";
import { derivedLabel, generationLabel, promptSummary } from "./artifact-label.js";

describe("promptSummary", () => {
  it("collapses whitespace and trims", () => {
    expect(promptSummary("  a  cat\n dancing ")).toBe("a cat dancing");
  });

  it("returns an empty string for missing or blank prompts", () => {
    expect(promptSummary(undefined)).toBe("");
    expect(promptSummary("   ")).toBe("");
  });

  it("truncates long prompts on a word boundary", () => {
    const summary = promptSummary(
      "a cat dancing in the rain while the whole city watches from balconies",
    );
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(61);
    expect(summary).not.toContain("  ");
    expect(summary.startsWith("a cat dancing in the rain")).toBe(true);
  });

  it("keeps prompts at the limit intact", () => {
    const exact = "x".repeat(60);
    expect(promptSummary(exact)).toBe(exact);
  });

  it("hard-clips a single unbroken token", () => {
    const summary = promptSummary("y".repeat(120));
    expect(summary).toBe(`${"y".repeat(60)}…`);
  });
});

describe("generationLabel", () => {
  it("reads as prose rather than a slug", () => {
    expect(generationLabel("kling-3.0/video", "a cat dancing in the rain"))
      .toBe("kling-3.0/video — a cat dancing in the rain");
  });

  it("falls back to the model alone without a prompt", () => {
    expect(generationLabel("nano-banana-pro")).toBe("nano-banana-pro");
    expect(generationLabel("nano-banana-pro", "  ")).toBe("nano-banana-pro");
  });
});

describe("derivedLabel", () => {
  it("names the operation and its source", () => {
    expect(derivedLabel("upscaled", "beach sunset")).toBe("upscaled — beach sunset");
  });

  it("falls back to the operation when the source is unlabeled", () => {
    expect(derivedLabel("upscaled", undefined)).toBe("upscaled");
    expect(derivedLabel("upscaled", "")).toBe("upscaled");
  });
});

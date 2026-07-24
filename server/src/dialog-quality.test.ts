import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessDialogQuality, readAndAssessDialog } from "./dialog-quality.js";
import { createEngineForTest } from "./fs.js";
import type { Engine } from "videobook-engine";

describe("assessDialogQuality", () => {
  it("returns hasDialog=false with reason 'empty' for empty text", () => {
    const result = assessDialogQuality({ text: "" });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("empty");
    expect(result.wordCount).toBe(0);
  });

  it("returns hasDialog=false with reason 'empty' for undefined text", () => {
    const result = assessDialogQuality({ text: undefined });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("empty");
    expect(result.wordCount).toBe(0);
  });

  it("returns hasDialog=false with reason 'empty' for missing text property", () => {
    const result = assessDialogQuality({});
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("returns hasDialog=false with reason 'empty' for whitespace-only text", () => {
    const result = assessDialogQuality({ text: "   \n\t  " });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("returns hasDialog=false with reason 'noise_only' for noise tags only", () => {
    const result = assessDialogQuality({ text: "[music] [laughter]" });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("noise_only");
    expect(result.wordCount).toBe(0);
  });

  it("returns hasDialog=false with reason 'noise_only' for a single noise tag", () => {
    const result = assessDialogQuality({ text: "[applause]" });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("noise_only");
  });

  it("returns hasDialog=false with reason 'too_short' for text under 3 words", () => {
    const result = assessDialogQuality({ text: "hi" });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("too_short");
    expect(result.wordCount).toBe(1);
  });

  it("returns hasDialog=false with reason 'too_short' for two words", () => {
    const result = assessDialogQuality({ text: "hello there" });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("too_short");
    expect(result.wordCount).toBe(2);
  });

  it("returns hasDialog=false with reason 'nonsensical' for repeated words", () => {
    const result = assessDialogQuality({
      text: "foo foo foo foo foo foo foo foo foo foo",
    });
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("nonsensical");
    expect(result.wordCount).toBe(10);
  });

  it("returns hasDialog=true with reason 'real_dialog' for real dialog", () => {
    const result = assessDialogQuality({
      text: "The quick brown fox jumps over the lazy dog",
    });
    expect(result.hasDialog).toBe(true);
    expect(result.reason).toBe("real_dialog");
    expect(result.wordCount).toBe(9);
  });

  it("returns hasDialog=true when noise tags are mixed with real dialog", () => {
    const result = assessDialogQuality({
      text: "[music] The quick brown fox jumps over the lazy dog",
    });
    expect(result.hasDialog).toBe(true);
    expect(result.reason).toBe("real_dialog");
    // word count is based on stripped text (without noise tags)
    expect(result.wordCount).toBe(9);
  });

  it("preserves the original trimmed text in the result", () => {
    const result = assessDialogQuality({
      text: "  The quick brown fox jumps over the lazy dog  ",
    });
    expect(result.text).toBe("The quick brown fox jumps over the lazy dog");
  });
});

describe("readAndAssessDialog", () => {
  let fs: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-dialog-test-"));
    fs = createEngineForTest(tempDir);
    await fs.projects.create("test-proj");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns real dialog quality for valid transcription file", async () => {
    const assetResult = await fs.artifacts.create("vid", "dialog-asset");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.slug;

    const transcription = JSON.stringify({ text: "The quick brown fox jumps over the lazy dog" });
    await fs.files.write(assetId, ".analysis.gpt4otrans.json", transcription);

    const result = await readAndAssessDialog(fs, assetId, "test-proj");
    expect(result.hasDialog).toBe(true);
    expect(result.reason).toBe("real_dialog");
    expect(result.wordCount).toBe(9);
  });

  it("returns no_transcription for nonexistent transcription file", async () => {
    const assetResult = await fs.artifacts.create("vid", "no-trans");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.slug;

    const result = await readAndAssessDialog(fs, assetId, "test-proj");
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("no_transcription");
    expect(result.text).toBe("");
    expect(result.wordCount).toBe(0);
  });

  it("returns no_transcription for invalid JSON in transcription file", async () => {
    const assetResult = await fs.artifacts.create("vid", "bad-json");
    if (!assetResult.ok) throw new Error(assetResult.error.message);
    const assetId = assetResult.value.slug;

    await fs.files.write(assetId, ".analysis.gpt4otrans.json", "not valid json {{{");

    const result = await readAndAssessDialog(fs, assetId, "test-proj");
    expect(result.hasDialog).toBe(false);
    expect(result.reason).toBe("no_transcription");
    expect(result.text).toBe("");
    expect(result.wordCount).toBe(0);
  });
});

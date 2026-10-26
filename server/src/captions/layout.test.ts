import { describe, expect, it } from "vitest";
import { applyCaptionEdits } from "./edits.js";
import type { CaptionMeasure, CaptionRegionFrame } from "./layout.js";
import { activeCaptionBlock, baseCaptionFontSize, captionTextWidthLimit, DEFAULT_CAPTION_POSITIONS, layoutCaptions } from "./layout.js";
import type { CaptionDocument } from "./model.js";
import { captionOutputFps, containRect, displayDimensions } from "./geometry.js";
import { captionWordLook, cueVisibility, punchWord } from "./motion.js";
import type { CaptionSeedWord } from "./seed.js";
import { seedCaptionDocument } from "./seed.js";

const measure: CaptionMeasure = (text, font) => [...text].length * font.size * 0.55;

function words(texts: string[], spacing = 0.3): CaptionSeedWord[] {
  return texts.map((text, index) => ({ text, start: index * spacing, end: index * spacing + spacing * 0.9, onset: index * spacing, energy: 0.5, speaker: null }));
}

function documentOf(texts: string[], source = { width: 1920, height: 1080 }): CaptionDocument {
  return seedCaptionDocument({
    source: { artifactId: "video", mediaHash: "hash", durationSeconds: 60, width: source.width, height: source.height, fps: 30 },
    bindings: { transcriptKey: "t", vocalKey: "v", translationKey: null },
    language: "original",
    sourceLanguage: "en",
    wordTiming: "measured",
    words: words(texts),
  });
}

describe("caption layout", () => {
  it("keeps karaoke phrases within two lines inside the TikTok-safe width, shrinking long words", () => {
    const seeded = documentOf(["Supercalifragilistic", "expialidociousness", "unbelievable"]);
    const document = applyCaptionEdits(seeded, seeded.phrases.slice(0, -1).map(() => ({ op: "merge_phrase" as const, phrase_id: seeded.phrases[0].id })));
    expect(document.phrases).toHaveLength(1);
    const [block] = layoutCaptions({ document, regions: [], measure });
    const limit = captionTextWidthLimit("9:16");
    expect(limit).toBeCloseTo(810, 6);
    expect(block.lines.length).toBeLessThanOrEqual(2);
    expect(block.fontSize).toBeLessThan(baseCaptionFontSize(document, "9:16"));
    for (const line of block.lines) expect(line.width).toBeLessThanOrEqual(limit + 1e-6);
    expect(block.x + block.width / 2).toBeCloseTo(540, 6);
    expect(block.placement).toBe("auto");
    expect(block.centerY).toBeCloseTo(DEFAULT_CAPTION_POSITIONS["9:16"], 6);
  });

  it("applies global and per-phrase positions per aspect and clamps blocks inside the frame", () => {
    const seeded = documentOf(["one", "two", "three.", "four", "five", "six."]);
    const document = applyCaptionEdits(seeded, [
      { op: "set_position", y: 0.25 },
      { op: "set_phrase_position", phrase_id: seeded.phrases[1].id, y: 1 },
      { op: "set_position", aspect: "16:9", y: 0.5 },
    ]);
    const [first, second] = layoutCaptions({ document, regions: [], measure });
    expect(first).toMatchObject({ placement: "global" });
    expect(first.centerY).toBeCloseTo(0.25, 6);
    expect(second.placement).toBe("phrase");
    expect(second.y + second.height).toBeLessThanOrEqual(1920 * 0.98 + 1e-6);
    expect(second.centerY).toBeLessThan(1);
    const landscape = layoutCaptions({ document, regions: [], measure, aspect: "16:9" });
    expect(landscape[0].centerY).toBeCloseTo(0.5, 6);
    expect(landscape[1].centerY).toBeCloseTo(0.5, 6);
    const unset = layoutCaptions({ document: applyCaptionEdits(document, [{ op: "set_position", aspect: "16:9", y: null }]), regions: [], measure, aspect: "16:9" });
    expect(unset[1].centerY).toBeCloseTo(DEFAULT_CAPTION_POSITIONS["16:9"], 6);
  });

  it("moves automatic placements off faces but never overrides manual positions", () => {
    const document = documentOf(["look", "at", "me"], { width: 1080, height: 1920 });
    const face: CaptionRegionFrame = { time: 0.3, regions: [{ kind: "face", confidence: 0.9, x: 0.2, y: 0.6, width: 0.6, height: 0.2 }] };
    const [avoided] = layoutCaptions({ document, regions: [face], measure });
    expect(avoided.placement).toBe("avoided");
    const faceTop = 0.6 * 1920 - 0.012 * 1920;
    const faceBottom = 0.8 * 1920 + 0.012 * 1920;
    expect(avoided.y + avoided.height <= faceTop || avoided.y >= faceBottom).toBe(true);
    const ignored = layoutCaptions({ document: applyCaptionEdits(document, [{ op: "set_style", style: { avoidFaces: false } }]), regions: [face], measure });
    expect(ignored[0].placement).toBe("auto");
    const manual = layoutCaptions({ document: applyCaptionEdits(document, [{ op: "set_position", y: 0.7 }]), regions: [face], measure });
    expect(manual[0]).toMatchObject({ placement: "global" });
    expect(manual[0].centerY).toBeCloseTo(0.7, 6);
  });

  it("maps source regions through the contain fit of the output frame", () => {
    expect(containRect({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toEqual({ x: 0, y: 656.25, width: 1080, height: 607.5 });
    expect(displayDimensions({ width: 1920, height: 1080, rotationDegrees: 90, pixelAspect: { numerator: 1, denominator: 1 } })).toEqual({ width: 1080, height: 1920 });
    expect(displayDimensions({ width: 720, height: 576, rotationDegrees: 0, pixelAspect: { numerator: 16, denominator: 15 } })).toEqual({ width: 768, height: 576 });
    expect(captionOutputFps({ numerator: 30000, denominator: 1001 }, undefined)).toBe(30);
    expect(captionOutputFps({ numerator: 24000, denominator: 1001 }, undefined)).toBe(24);
    expect(captionOutputFps({ numerator: 90000, denominator: 1 }, undefined)).toBe(30);
    expect(captionOutputFps(undefined, { numerator: 50, denominator: 1 })).toBe(50);
  });

  it("sizes punch words one at a time and stacks at most two words per line", () => {
    const base = documentOf(["Thunderstruck", "now"]);
    const punch = applyCaptionEdits(base, [{ op: "set_style", style: { preset: "punch" } }]);
    const [punchBlock] = layoutCaptions({ document: punch, regions: [], measure });
    expect(punchBlock.lines.map((line) => line.words.length)).toEqual([1, 1]);
    expect(Math.max(...punchBlock.lines.map((line) => line.width))).toBeLessThanOrEqual(captionTextWidthLimit("9:16") + 1e-6);
    expect(punchBlock.height).toBeCloseTo(punchBlock.lineHeight, 6);
    expect(punchWord(punchBlock.cue, 0.35)?.text).toBe("now");
    const stack = applyCaptionEdits(documentOf(["we", "go", "far", "now."]), [{ op: "set_style", style: { preset: "stack" } }]);
    const [stackBlock] = layoutCaptions({ document: stack, regions: [], measure });
    expect(stackBlock.lines.map((line) => line.words.length)).toEqual([2, 2]);
  });

  it("joins unspaced scripts tightly and lays out right-to-left text", () => {
    const japanese = documentOf(["今日", "は", "いい"]);
    const [block] = layoutCaptions({ document: japanese, regions: [], measure });
    expect(block.lines[0].width).toBeCloseTo(measure("今日はいい", { family: "x", weight: 800, size: block.fontSize }), 6);
    const arabic = documentOf(["مرحبا", "بالعالم"]);
    expect(layoutCaptions({ document: arabic, regions: [], measure })[0].direction).toBe("rtl");
  });

  it("finds the active block and highlights only measured words", () => {
    const document = documentOf(["hello", "world"]);
    const blocks = layoutCaptions({ document, regions: [], measure });
    const block = activeCaptionBlock(blocks, 0.35);
    expect(block?.cue.words.map((word) => word.text)).toEqual(["hello", "world"]);
    expect(activeCaptionBlock(blocks, 5)).toBeNull();
    const second = block!.cue.words[1];
    expect(captionWordLook(second, 0.35, document.style, 70, true).highlighted).toBe(true);
    expect(captionWordLook(second, 0.35, document.style, 70, false).highlighted).toBe(false);
    expect(cueVisibility(block!.cue, block!.cue.start, 70).opacity).toBe(0);
    expect(cueVisibility(block!.cue, block!.cue.start + 0.2, 70).opacity).toBeCloseTo(1, 6);
  });
});

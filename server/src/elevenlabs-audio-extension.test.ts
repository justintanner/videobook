import { describe, expect, it } from "vitest";
import {
  buildSoundContinuationPrompt,
  MAX_CONTINUATION_DIRECTION_CHARS,
  MAX_SOUND_GENERATION_PROMPT_CHARS,
  normalizeContinuationPrompt,
} from "./elevenlabs-audio-extension.js";

const LONG_SOURCE = "crowd cheering and stadium chants with distant drums ".repeat(6).trim();

describe("normalizeContinuationPrompt", () => {
  it("returns undefined for missing or blank prompts", () => {
    expect(normalizeContinuationPrompt(undefined)).toBeUndefined();
    expect(normalizeContinuationPrompt("")).toBeUndefined();
    expect(normalizeContinuationPrompt("   ")).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeContinuationPrompt("  add outro music  ")).toBe("add outro music");
  });

  it("unwraps a single pair of enclosing parentheses", () => {
    expect(normalizeContinuationPrompt("(add outro music)")).toBe("add outro music");
    expect(normalizeContinuationPrompt("( add outro music )")).toBe("add outro music");
  });

  it("keeps prompts whose parentheses are not a plain wrapper", () => {
    expect(normalizeContinuationPrompt("(a) then (b)")).toBe("(a) then (b)");
    expect(normalizeContinuationPrompt("fade out (slowly)")).toBe("fade out (slowly)");
  });

  it("returns undefined when parentheses wrap nothing", () => {
    expect(normalizeContinuationPrompt("()")).toBeUndefined();
    expect(normalizeContinuationPrompt("(  )")).toBeUndefined();
  });
});

describe("buildSoundContinuationPrompt", () => {
  it("keeps the seamless-continuation prompt when no direction is given", () => {
    const prompt = buildSoundContinuationPrompt("horse neighing", 9.452);
    expect(prompt).toContain("Continue this audio seamlessly for 9.5s: horse neighing.");
    expect(prompt).toContain("Repeat or vary the source event naturally");
    expect(prompt).toContain("No intro, unrelated sound, fade-in, early ending, or silent tail.");
    expect(prompt.length).toBeLessThanOrEqual(MAX_SOUND_GENERATION_PROMPT_CHARS);
  });

  it("leads with the direction so a long source description cannot truncate it", () => {
    const prompt = buildSoundContinuationPrompt(LONG_SOURCE, 9.452, "add outro music");
    expect(prompt.startsWith("Continue this audio for 9.5s: add outro music.")).toBe(true);
    expect(prompt).toContain("Source audio: crowd cheering");
    expect(prompt.length).toBeLessThanOrEqual(MAX_SOUND_GENERATION_PROMPT_CHARS);
  });

  it("keeps a maximum-length direction and the tail constraint intact together", () => {
    const direction = "d".repeat(MAX_CONTINUATION_DIRECTION_CHARS);
    const prompt = buildSoundContinuationPrompt(LONG_SOURCE, 29.5, direction);
    expect(prompt).toContain(direction);
    expect(prompt).toContain("audible through the final second with no silent tail.");
    expect(prompt.length).toBeLessThanOrEqual(MAX_SOUND_GENERATION_PROMPT_CHARS);
  });

  it("drops the sameness constraints that would contradict a direction", () => {
    const prompt = buildSoundContinuationPrompt("horse neighing", 9.452, "add outro music");
    expect(prompt).not.toContain("unrelated sound");
    expect(prompt).not.toContain("Repeat or vary the source event");
  });

  it("unwraps a parenthesized direction before prompting", () => {
    const prompt = buildSoundContinuationPrompt("horse neighing", 9.452, "(add outro music)");
    expect(prompt).toContain("Continue this audio for 9.5s: add outro music.");
    expect(prompt).not.toContain("(add outro music)");
  });

  it("collapses trailing punctuation in the direction to one sentence break", () => {
    const prompt = buildSoundContinuationPrompt("horse neighing", 9.452, "add outro music!!!");
    expect(prompt).toContain("Continue this audio for 9.5s: add outro music.");
  });
});

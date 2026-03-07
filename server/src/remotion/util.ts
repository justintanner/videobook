import type { Word } from "./subtitles/types.js";

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function hexToRgba(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function getCurrentWordIndex(words: Word[], currentTime: number, lingerDuration = 0): number {
  for (let i = 0; i < words.length; i++) {
    let wordEnd = words[i].end;
    if (lingerDuration > 0 && i + 1 < words.length) {
      wordEnd = Math.min(wordEnd + lingerDuration, words[i + 1].start - 0.01);
    } else if (lingerDuration > 0) {
      wordEnd = wordEnd + lingerDuration;
    }
    if (words[i].start <= currentTime && currentTime <= wordEnd) {
      return i;
    }
  }
  return -1;
}

export function stripPunctuation(text: string): string {
  return text.replace(/[^\w\s]/g, "");
}

import { joinsWithoutSpace } from "../captions/script.js";
import type { Word } from "./subtitles/types.js";

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

export function joinsPreviousWord(words: readonly Word[], index: number): boolean {
  return index > 0 && index < words.length && joinsWithoutSpace(words[index - 1].word, words[index].word);
}

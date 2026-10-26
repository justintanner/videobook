import { isUnspacedText } from "./captions/script.js";

export interface TranscriptToken {
  text: string;
  start: number;
  end: number;
  type?: string;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function isWordToken(token: TranscriptToken): boolean {
  return (token.type ?? "word") === "word";
}

function continuesLetters(token: TranscriptToken, letters: readonly TranscriptToken[]): boolean {
  if (!isWordToken(token)) return false;
  return isUnspacedText(token.text) || (letters.length > 0 && !LETTER_OR_DIGIT.test(token.text));
}

function wordStarts(text: string): Set<number> {
  const starts = new Set<number>();
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) starts.add(segment.index);
  }
  return starts;
}

function joined<T extends TranscriptToken>(tokens: readonly T[]): T {
  return { ...tokens[0], text: tokens.map((token) => token.text).join(""), end: tokens[tokens.length - 1].end };
}

function regroup<T extends TranscriptToken>(letters: readonly T[]): T[] {
  if (letters.length < 2) return [...letters];
  const starts = wordStarts(letters.map((token) => token.text).join(""));
  const words: T[][] = [];
  let offset = 0;
  for (const letter of letters) {
    if (words.length === 0 || starts.has(offset)) words.push([letter]);
    else words[words.length - 1].push(letter);
    offset += letter.text.length;
  }
  return words.map(joined);
}

export function joinUnspacedLetters<T extends TranscriptToken>(tokens: readonly T[]): T[] {
  const result: T[] = [];
  let letters: T[] = [];
  for (const token of tokens) {
    if (continuesLetters(token, letters)) {
      letters.push(token);
      continue;
    }
    result.push(...regroup(letters), token);
    letters = [];
  }
  result.push(...regroup(letters));
  return result;
}

export function splitUnspacedText(text: string): string[] {
  const words: string[] = [];
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike || words.length === 0) words.push(segment.segment);
    else words[words.length - 1] += segment.segment;
  }
  return words;
}

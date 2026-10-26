import { isUnspacedText } from "./captions/script.js";

export interface TranscriptToken {
  text: string;
  start: number;
  end: number;
  type?: string;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const THAI_ONSET = "(?:[กขคปพต][รลว]|ห[งญนมยรลว]|อย|[ก-ฮ])";
const THAI_DEPENDENT_START = /^(?:[ะ-ฺ็-๎]|[ก-ฮ]์)/u;
const THAI_OE_OPENING = new RegExp(`เ${THAI_ONSET}[่-๋]?$`, "u");
const THAI_OE_CLOSING = /^อ(?:$|[ก-ฮ]์|[เ-ไ]|[^\u0E00-\u0E7F])/u;
const THAI_LEADING_ONSET = /[เแโใไ]([ก-ฮ])$/u;
const THAI_CLUSTER = /^(?:[กขคปพต][รลว]|ห[งญนมยรลว]|อย)$/u;

function isWordToken(token: TranscriptToken): boolean {
  return (token.type ?? "word") === "word";
}

function continuesLetters(token: TranscriptToken, letters: readonly TranscriptToken[]): boolean {
  if (!isWordToken(token)) return false;
  return isUnspacedText(token.text) || (letters.length > 0 && !LETTER_OR_DIGIT.test(token.text));
}

function splitsThaiSyllable(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 4), index);
  const after = text.slice(index, index + 3);
  if (THAI_DEPENDENT_START.test(after)) return true;
  if (THAI_OE_OPENING.test(before) && THAI_OE_CLOSING.test(after)) return true;
  const onset = THAI_LEADING_ONSET.exec(before);
  return onset !== null && THAI_CLUSTER.test(onset[1] + after.charAt(0));
}

function wordStarts(text: string): Set<number> {
  const starts = new Set<number>();
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike && !splitsThaiSyllable(text, segment.index)) starts.add(segment.index);
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
  const cuts = [...wordStarts(text)].filter((index) => index > 0).sort((left, right) => left - right);
  return [0, ...cuts].map((start, index) => text.slice(start, cuts[index] ?? text.length)).filter((word) => word.length > 0);
}

export function textWords(text: string): string[] {
  return text.split(/\s+/u).filter((chunk) => chunk.length > 0)
    .flatMap((chunk) => (isUnspacedText(chunk) ? splitUnspacedText(chunk) : [chunk]));
}

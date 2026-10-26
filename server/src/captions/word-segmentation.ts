import { captionDisplayText } from "./edits.js";
import type { CaptionDocument, CaptionWord } from "./model.js";
import { MAX_CAPTION_WORD_LENGTH } from "./model.js";
import { groupPhrases } from "./phrasing.js";

const THAI = /\p{Script=Thai}/u;
const THAI_TOKEN = /^[\p{Script=Thai}\p{P}]+$/u;
const segmenter = new Intl.Segmenter("th", { granularity: "word" });

function canGroup(word: CaptionWord): boolean {
  return word.analysed !== null && !word.textCorrected && !word.timingCorrected && !word.hidden
    && THAI.test(word.analysed.text) && THAI_TOKEN.test(word.analysed.text);
}

function mergeWords(words: readonly CaptionWord[]): CaptionWord {
  const first = words[0];
  if (words.length === 1) return first;
  const analyses = words.map((word) => word.analysed!);
  const text = analyses.map((word) => word.text).join("");
  const weight = analyses.reduce((sum, word) => sum + Math.max(0.001, word.end - word.start), 0);
  const energy = analyses.reduce((sum, word) => sum + word.energy * Math.max(0.001, word.end - word.start), 0) / weight;
  return {
    ...first,
    text: captionDisplayText(text),
    end: Math.max(...words.map((word) => word.end)),
    analysed: { ...analyses[0], text, end: Math.max(...analyses.map((word) => word.end)), energy },
  };
}

function segmentRun(words: readonly CaptionWord[]): CaptionWord[] {
  if (words.length < 2) return [...words];
  const text = words.map((word) => word.analysed!.text).join("");
  const boundaries = new Set([...segmenter.segment(text)].map((part) => part.index + part.segment.length));
  const grouped: CaptionWord[] = [];
  let pending: CaptionWord[] = [];
  let length = 0;
  for (const word of words) {
    pending.push(word);
    length += word.analysed!.text.length;
    if (!boundaries.has(length)) continue;
    const merged = mergeWords(pending);
    if (merged.text.length <= MAX_CAPTION_WORD_LENGTH) grouped.push(merged);
    else grouped.push(...pending);
    pending = [];
  }
  return grouped;
}

function groupWords(words: readonly CaptionWord[]): CaptionWord[] {
  const grouped: CaptionWord[] = [];
  let run: CaptionWord[] = [];
  const flush = () => {
    grouped.push(...segmentRun(run));
    run = [];
  };
  for (const word of words) {
    const last = run.at(-1);
    if (last && (word.start - last.end >= 0.45 || last.speaker !== word.speaker)) flush();
    if (canGroup(word)) run.push(word);
    else {
      flush();
      grouped.push(word);
    }
  }
  flush();
  return grouped;
}

function automaticGroups(words: readonly CaptionWord[]): string[][] {
  return groupPhrases(words.map((word) => ({ ...word, text: word.analysed?.text ?? word.text })));
}

function hasAutomaticPhrases(document: CaptionDocument): boolean {
  return document.phrases.every((phrase) => Object.keys(phrase.positions).length === 0)
    && JSON.stringify(document.phrases.map((phrase) => phrase.wordIds)) === JSON.stringify(automaticGroups(document.words));
}

export function normalizeCaptionWords(document: CaptionDocument): CaptionDocument {
  if (document.wordSegmentationVersion === 1 || !document.words.some((word) => THAI.test(word.text))) return document;
  const normalized: CaptionDocument = { ...document, wordSegmentationVersion: 1 };
  if (!hasAutomaticPhrases(document)) {
    const byId = new Map(document.words.map((word) => [word.id, word]));
    const groups = document.phrases.map((phrase) => groupWords(phrase.wordIds.map((id) => byId.get(id)!)));
    const words = groups.flat();
    if (words.length === document.words.length) return normalized;
    return { ...normalized, words, phrases: document.phrases.map((phrase, index) => ({ ...phrase, wordIds: groups[index].map((word) => word.id) })) };
  }
  const words = groupWords(document.words);
  if (words.length === document.words.length) return normalized;
  let nextId = document.nextId;
  const phrases = automaticGroups(words).map((wordIds, index) => {
    const id = document.phrases[index]?.id ?? `p${nextId++}`;
    return { id, wordIds, positions: {} };
  });
  return { ...normalized, words, phrases, nextId };
}

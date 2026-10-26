import type {
  CaptionAspect,
  CaptionBindings,
  CaptionDocument,
  CaptionPhrase,
  CaptionPositions,
  CaptionSource,
  CaptionStyle,
  CaptionWord,
} from "./model.js";
import { CAPTION_DOCUMENT_VERSION, DEFAULT_CAPTION_ASPECT, DEFAULT_CAPTION_STYLE } from "./model.js";
import { captionDisplayText } from "./edits.js";
import { groupPhrases } from "./phrasing.js";
import { normalizeCaptionWords } from "./word-segmentation.js";

export interface CaptionSeedWord {
  text: string;
  start: number;
  end: number;
  onset: number;
  energy: number;
  speaker: string | null;
}

export interface CaptionSeedInput {
  source: CaptionSource;
  bindings: CaptionBindings;
  language: string;
  sourceLanguage: string | null;
  wordTiming: CaptionDocument["wordTiming"];
  words: readonly CaptionSeedWord[];
  style?: CaptionStyle;
  aspect?: CaptionAspect;
  positions?: CaptionPositions;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function seedWord(word: CaptionSeedWord, number: number): CaptionWord {
  const start = round(word.start);
  const end = round(Math.max(word.end, word.start + 0.04));
  return {
    id: `w${number}`,
    text: captionDisplayText(word.text),
    start,
    end,
    analysed: { text: word.text, start, end, onset: round(word.onset), energy: Math.max(0, Math.min(1, word.energy)) },
    textCorrected: false,
    timingCorrected: false,
    hidden: false,
    speaker: word.speaker,
  };
}

function usableWords(words: readonly CaptionSeedWord[]): CaptionSeedWord[] {
  return words
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.text.trim().length > 0)
    .map((word) => ({ ...word, start: Math.max(0, word.start), end: Math.max(0, word.end) }))
    .sort((left, right) => left.start - right.start);
}

function phraseInputs(words: readonly CaptionWord[]) {
  return words.map((word) => ({ id: word.id, text: word.analysed?.text ?? word.text, start: word.start, end: word.end }));
}

function phrasesFor(words: readonly CaptionWord[], firstNumber: number): CaptionPhrase[] {
  return groupPhrases(phraseInputs(words)).map((wordIds, index) => ({ id: `p${firstNumber + index}`, wordIds, positions: {} }));
}

export function seedCaptionDocument(input: CaptionSeedInput): CaptionDocument {
  const words = usableWords(input.words).map((word, index) => seedWord(word, index + 1));
  const phrases = phrasesFor(words, words.length + 1);
  return normalizeCaptionWords({
    version: CAPTION_DOCUMENT_VERSION,
    language: input.language,
    sourceLanguage: input.sourceLanguage,
    wordTiming: input.wordTiming,
    source: input.source,
    bindings: input.bindings,
    aspect: input.aspect ?? DEFAULT_CAPTION_ASPECT,
    positions: input.positions ?? {},
    style: input.style ?? DEFAULT_CAPTION_STYLE,
    words,
    phrases,
    nextId: words.length + phrases.length + 1,
  });
}

function normalized(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const MATCH_WINDOW_SECONDS = 0.6;

interface Alignment {
  oldToNew: Map<string, number>;
}

function timeKey(word: CaptionWord): number {
  return word.analysed?.start ?? word.start;
}

function textKey(word: CaptionWord): string {
  return normalized(word.analysed?.text ?? word.text);
}

function alignByText(previous: readonly CaptionWord[], next: readonly CaptionWord[], shift: number, oldToNew: Map<string, number>): void {
  let cursor = 0;
  for (const word of previous) {
    const key = textKey(word);
    const time = timeKey(word) + shift;
    for (let index = cursor; index < next.length; index += 1) {
      const candidate = next[index];
      if (candidate.start > time + MATCH_WINDOW_SECONDS) break;
      if (Math.abs(candidate.start - time) <= MATCH_WINDOW_SECONDS && textKey(candidate) === key) {
        oldToNew.set(word.id, index);
        cursor = index + 1;
        break;
      }
    }
  }
}

function overlapRatio(word: CaptionWord, candidate: CaptionWord, shift: number): number {
  const start = (word.analysed?.start ?? word.start) + shift;
  const end = (word.analysed?.end ?? word.end) + shift;
  const overlap = Math.min(end, candidate.end) - Math.max(start, candidate.start);
  const span = Math.max(end, candidate.end) - Math.min(start, candidate.start);
  return span > 0 ? Math.max(0, overlap) / span : 0;
}

function alignCorrectionsByTime(previous: readonly CaptionWord[], next: readonly CaptionWord[], shift: number, oldToNew: Map<string, number>): void {
  const taken = new Set(oldToNew.values());
  for (const word of previous) {
    if (oldToNew.has(word.id) || !word.textCorrected || !word.analysed) continue;
    const index = next.findIndex((candidate, at) => !taken.has(at) && overlapRatio(word, candidate, shift) >= 0.5);
    if (index < 0) continue;
    oldToNew.set(word.id, index);
    taken.add(index);
  }
}

function alignWords(previous: readonly CaptionWord[], next: readonly CaptionWord[], shift: number): Alignment {
  const oldToNew = new Map<string, number>();
  alignByText(previous, next, shift, oldToNew);
  alignCorrectionsByTime(previous, next, shift, oldToNew);
  return { oldToNew };
}

function estimatedShift(previous: readonly CaptionWord[], next: readonly CaptionWord[]): number {
  const counts = new Map<string, number>();
  for (const word of next) counts.set(textKey(word), (counts.get(textKey(word)) ?? 0) + 1);
  const deltas: number[] = [];
  for (const word of previous) {
    const key = textKey(word);
    if (key.length < 3 || counts.get(key) !== 1) continue;
    const match = next.find((candidate) => textKey(candidate) === key);
    if (match) deltas.push(match.start - timeKey(word));
  }
  if (deltas.length === 0) return 0;
  deltas.sort((left, right) => left - right);
  return deltas[Math.floor(deltas.length / 2)];
}

export interface CaptionReseedResult {
  document: CaptionDocument;
  kept: number;
  unplaced: number;
  shiftSeconds: number;
}

function isCorrected(word: CaptionWord): boolean {
  return word.textCorrected || word.timingCorrected || word.hidden || word.analysed === null;
}

function carriedWord(previous: CaptionWord, seeded: CaptionWord, shift: number): CaptionWord {
  return {
    ...seeded,
    id: previous.id,
    text: previous.textCorrected ? previous.text : seeded.text,
    start: previous.timingCorrected ? round(previous.start + shift) : seeded.start,
    end: previous.timingCorrected ? round(previous.end + shift) : seeded.end,
    textCorrected: previous.textCorrected,
    timingCorrected: previous.timingCorrected,
    hidden: previous.hidden,
  };
}

function shiftedManualWord(word: CaptionWord, shift: number): CaptionWord {
  return { ...word, start: round(Math.max(0, word.start + shift)), end: round(Math.max(0.04, word.end + shift)) };
}

function mergedWords(previous: CaptionDocument, seed: CaptionDocument, alignment: Alignment, shift: number) {
  const byNewIndex = new Map<number, CaptionWord>();
  for (const word of previous.words) {
    const index = alignment.oldToNew.get(word.id);
    if (index !== undefined) byNewIndex.set(index, carriedWord(word, seed.words[index], shift));
  }
  let nextId = Math.max(previous.nextId, 1);
  const words: CaptionWord[] = seed.words.map((word, index) => {
    const carried = byNewIndex.get(index);
    if (carried) return carried;
    const id = `w${nextId}`;
    nextId += 1;
    return { ...word, id };
  });
  const manual = previous.words.filter((word) => !alignment.oldToNew.has(word.id) && isCorrected(word) && !word.hidden);
  const placed = manual.map((word) => shiftedManualWord(word, shift)).filter((word) => word.end <= seed.source.durationSeconds + 1);
  return { words: [...words, ...placed].sort((left, right) => left.start - right.start), nextId, unplaced: manual.length - placed.length };
}

function phraseOf(previous: CaptionDocument): Map<string, CaptionPhrase> {
  const map = new Map<string, CaptionPhrase>();
  for (const phrase of previous.phrases) for (const id of phrase.wordIds) map.set(id, phrase);
  return map;
}

function mergedPhrases(previous: CaptionDocument, words: readonly CaptionWord[], firstId: number) {
  const owners = phraseOf(previous);
  const phrases: CaptionPhrase[] = [];
  let nextId = firstId;
  let orphanRun: CaptionWord[] = [];
  const flushOrphans = () => {
    for (const wordIds of groupPhrases(phraseInputs(orphanRun))) {
      phrases.push({ id: `p${nextId}`, wordIds, positions: {} });
      nextId += 1;
    }
    orphanRun = [];
  };
  for (const word of words) {
    const owner = owners.get(word.id);
    if (!owner) {
      orphanRun.push(word);
      continue;
    }
    flushOrphans();
    const last = phrases.at(-1);
    if (last && last.id === owner.id) last.wordIds.push(word.id);
    else phrases.push({ id: owner.id, wordIds: [word.id], positions: { ...owner.positions } });
  }
  flushOrphans();
  return { phrases: uniquePhraseIds(phrases, () => {
    const id = `p${nextId}`;
    nextId += 1;
    return id;
  }), nextId };
}

function uniquePhraseIds(phrases: CaptionPhrase[], mint: () => string): CaptionPhrase[] {
  const seen = new Set<string>();
  return phrases.map((phrase) => {
    if (!seen.has(phrase.id)) {
      seen.add(phrase.id);
      return phrase;
    }
    return { ...phrase, id: mint(), positions: {} };
  });
}

export function reseedCaptionDocument(previous: CaptionDocument, seed: CaptionDocument, options: { realign: boolean }): CaptionReseedResult {
  const shift = options.realign ? estimatedShift(previous.words, seed.words) : 0;
  const alignment = alignWords(previous.words, seed.words, shift);
  const corrected = previous.words.filter(isCorrected).length;
  const merged = mergedWords(previous, seed, alignment, shift);
  const phrases = mergedPhrases(previous, merged.words, merged.nextId);
  const document: CaptionDocument = {
    ...seed,
    language: previous.language,
    aspect: previous.aspect,
    positions: previous.positions,
    style: previous.style,
    words: merged.words,
    phrases: phrases.phrases,
    nextId: phrases.nextId,
  };
  return { document, kept: corrected - merged.unplaced, unplaced: merged.unplaced, shiftSeconds: shift };
}

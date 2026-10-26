import type { CaptionAspect, CaptionDocument, CaptionPhrase, CaptionStyle, CaptionWord } from "./model.js";
import {
  captionStyleSchema,
  MAX_CAPTION_WORD_LENGTH,
  MIN_CAPTION_WORD_SECONDS,
  nextCaptionId,
} from "./model.js";

export class CaptionEditError extends Error {}

export type CaptionEdit =
  | { op: "set_word_text"; word_id: string; text: string }
  | { op: "set_word_timing"; word_id: string; start: number; end: number }
  | { op: "hide_word"; word_id: string; hidden: boolean }
  | { op: "insert_word"; after_word_id: string; text: string; start: number; end: number }
  | { op: "reset_word"; word_id: string }
  | { op: "split_phrase"; word_id: string }
  | { op: "merge_phrase"; phrase_id: string }
  | { op: "set_phrase_position"; phrase_id: string; aspect?: CaptionAspect; y: number | null }
  | { op: "set_position"; aspect?: CaptionAspect; y: number | null }
  | { op: "set_style"; style: Partial<CaptionStyle> }
  | { op: "set_aspect"; aspect: CaptionAspect };

const TIME_TOLERANCE_SECONDS = 1;

function requireWord(document: CaptionDocument, wordId: string): CaptionWord {
  const word = document.words.find((candidate) => candidate.id === wordId);
  if (!word) throw new CaptionEditError(`Word ${wordId} is not in these subtitles.`);
  return word;
}

function requirePhrase(document: CaptionDocument, phraseId: string): CaptionPhrase {
  const phrase = document.phrases.find((candidate) => candidate.id === phraseId);
  if (!phrase) throw new CaptionEditError(`Phrase ${phraseId} is not in these subtitles.`);
  return phrase;
}

function phraseIndexOf(document: CaptionDocument, wordId: string): number {
  const index = document.phrases.findIndex((phrase) => phrase.wordIds.includes(wordId));
  if (index < 0) throw new CaptionEditError(`Word ${wordId} is not in a phrase.`);
  return index;
}

function replaceWord(document: CaptionDocument, word: CaptionWord): CaptionDocument {
  return { ...document, words: document.words.map((candidate) => (candidate.id === word.id ? word : candidate)) };
}

function cleanText(text: string): string {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (!trimmed) throw new CaptionEditError("Word text cannot be empty. Hide the word instead.");
  if (trimmed.length > MAX_CAPTION_WORD_LENGTH) throw new CaptionEditError(`Word text is limited to ${MAX_CAPTION_WORD_LENGTH} characters.`);
  return trimmed;
}

function setWordText(document: CaptionDocument, wordId: string, text: string): CaptionDocument {
  const word = requireWord(document, wordId);
  const next = cleanText(text);
  return replaceWord(document, { ...word, text: next, textCorrected: next !== analysedDisplay(word) });
}

function analysedDisplay(word: CaptionWord): string | null {
  return word.analysed ? captionDisplayText(word.analysed.text) : null;
}

function setWordTiming(document: CaptionDocument, wordId: string, start: number, end: number): CaptionDocument {
  const word = requireWord(document, wordId);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new CaptionEditError("Word times must be numbers.");
  const roundedStart = roundTime(start);
  const roundedEnd = roundTime(end);
  return replaceWord(document, { ...word, start: roundedStart, end: roundedEnd, timingCorrected: true });
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hideWord(document: CaptionDocument, wordId: string, hidden: boolean): CaptionDocument {
  return replaceWord(document, { ...requireWord(document, wordId), hidden });
}

function resetWord(document: CaptionDocument, wordId: string): CaptionDocument {
  const word = requireWord(document, wordId);
  if (!word.analysed) throw new CaptionEditError("This word was added by hand; remove it instead of resetting it.");
  return replaceWord(document, {
    ...word,
    text: captionDisplayText(word.analysed.text),
    start: word.analysed.start,
    end: word.analysed.end,
    textCorrected: false,
    timingCorrected: false,
    hidden: false,
  });
}

function insertWord(document: CaptionDocument, afterWordId: string, text: string, start: number, end: number): CaptionDocument {
  requireWord(document, afterWordId);
  const { id, nextId } = nextCaptionId(document, "w");
  const word: CaptionWord = {
    id,
    text: cleanText(text),
    start: roundTime(start),
    end: roundTime(end),
    analysed: null,
    textCorrected: true,
    timingCorrected: true,
    hidden: false,
    speaker: null,
  };
  const index = document.words.findIndex((candidate) => candidate.id === afterWordId);
  const words = [...document.words.slice(0, index + 1), word, ...document.words.slice(index + 1)];
  const phrases = document.phrases.map((phrase) => {
    const at = phrase.wordIds.indexOf(afterWordId);
    if (at < 0) return phrase;
    return { ...phrase, wordIds: [...phrase.wordIds.slice(0, at + 1), id, ...phrase.wordIds.slice(at + 1)] };
  });
  return { ...document, words, phrases, nextId };
}

function splitPhrase(document: CaptionDocument, wordId: string): CaptionDocument {
  const index = phraseIndexOf(document, wordId);
  const phrase = document.phrases[index];
  const at = phrase.wordIds.indexOf(wordId);
  if (at === 0) throw new CaptionEditError("That word already starts a phrase.");
  const { id, nextId } = nextCaptionId(document, "p");
  const head: CaptionPhrase = { ...phrase, wordIds: phrase.wordIds.slice(0, at) };
  const tail: CaptionPhrase = { id, wordIds: phrase.wordIds.slice(at), positions: { ...phrase.positions } };
  const phrases = [...document.phrases.slice(0, index), head, tail, ...document.phrases.slice(index + 1)];
  return { ...document, phrases, nextId };
}

function mergePhrase(document: CaptionDocument, phraseId: string): CaptionDocument {
  requirePhrase(document, phraseId);
  const index = document.phrases.findIndex((phrase) => phrase.id === phraseId);
  const next = document.phrases[index + 1];
  if (!next) throw new CaptionEditError("The last phrase has nothing after it to merge with.");
  const phrase = document.phrases[index];
  const merged: CaptionPhrase = { ...phrase, wordIds: [...phrase.wordIds, ...next.wordIds] };
  return { ...document, phrases: [...document.phrases.slice(0, index), merged, ...document.phrases.slice(index + 2)] };
}

function checkPosition(y: number | null): void {
  if (y !== null && (!Number.isFinite(y) || y < 0 || y > 1)) throw new CaptionEditError("Vertical positions are fractions of the frame height between 0 and 1.");
}

function withPosition<T extends { positions: CaptionDocument["positions"] }>(target: T, aspect: CaptionAspect, y: number | null): T {
  const positions = { ...target.positions };
  if (y === null) delete positions[aspect];
  else positions[aspect] = Math.round(y * 10_000) / 10_000;
  return { ...target, positions };
}

function setPhrasePosition(document: CaptionDocument, phraseId: string, aspect: CaptionAspect, y: number | null): CaptionDocument {
  checkPosition(y);
  const phrase = requirePhrase(document, phraseId);
  const updated = withPosition(phrase, aspect, y);
  return { ...document, phrases: document.phrases.map((candidate) => (candidate.id === phraseId ? updated : candidate)) };
}

function setPosition(document: CaptionDocument, aspect: CaptionAspect, y: number | null): CaptionDocument {
  checkPosition(y);
  return withPosition(document, aspect, y);
}

function setStyle(document: CaptionDocument, style: Partial<CaptionStyle>): CaptionDocument {
  const parsed = captionStyleSchema.safeParse({ ...document.style, ...style });
  if (!parsed.success) throw new CaptionEditError(`Invalid subtitle style: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return { ...document, style: parsed.data };
}

function applyCaptionEdit(document: CaptionDocument, edit: CaptionEdit): CaptionDocument {
  switch (edit.op) {
    case "set_word_text": return setWordText(document, edit.word_id, edit.text);
    case "set_word_timing": return setWordTiming(document, edit.word_id, edit.start, edit.end);
    case "hide_word": return hideWord(document, edit.word_id, edit.hidden);
    case "insert_word": return insertWord(document, edit.after_word_id, edit.text, edit.start, edit.end);
    case "reset_word": return resetWord(document, edit.word_id);
    case "split_phrase": return splitPhrase(document, edit.word_id);
    case "merge_phrase": return mergePhrase(document, edit.phrase_id);
    case "set_phrase_position": return setPhrasePosition(document, edit.phrase_id, edit.aspect ?? document.aspect, edit.y);
    case "set_position": return setPosition(document, edit.aspect ?? document.aspect, edit.y);
    case "set_style": return setStyle(document, edit.style);
    case "set_aspect": return { ...document, aspect: edit.aspect };
  }
}

export function applyCaptionEdits(document: CaptionDocument, edits: readonly CaptionEdit[]): CaptionDocument {
  const next = edits.reduce(applyCaptionEdit, document);
  const problems = captionDocumentProblems(next);
  if (problems.length > 0) throw new CaptionEditError(problems[0]);
  return next;
}

const TRAILING_PUNCTUATION = /[.,;:，。、；：]+$/u;

export function captionDisplayText(raw: string): string {
  const trimmed = raw.replace(/\s+/gu, " ").trim();
  const stripped = trimmed.replace(TRAILING_PUNCTUATION, "");
  return stripped || trimmed;
}

function duplicateIds(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

function phraseCoverageProblem(document: CaptionDocument): string | null {
  const order = document.phrases.flatMap((phrase) => phrase.wordIds);
  if (order.length !== document.words.length) return "Every word must belong to exactly one phrase.";
  const mismatch = order.findIndex((id, index) => document.words[index].id !== id);
  return mismatch >= 0 ? "Phrases must keep words in their spoken order." : null;
}

function timingProblem(document: CaptionDocument): string | null {
  const limit = document.source.durationSeconds + TIME_TOLERANCE_SECONDS;
  let previousStart = 0;
  for (const word of document.words) {
    if (word.end - word.start < MIN_CAPTION_WORD_SECONDS - 1e-9) return `Word "${word.text}" must last at least ${MIN_CAPTION_WORD_SECONDS * 1000} ms.`;
    if (word.end > limit) return `Word "${word.text}" ends after the video.`;
    if (word.hidden) continue;
    if (word.start + 1e-9 < previousStart) return `Word "${word.text}" starts before the word ahead of it.`;
    previousStart = word.start;
  }
  return null;
}

function highestNumber(ids: readonly string[]): number {
  return ids.reduce((max, id) => Math.max(max, Number(id.slice(1)) || 0), 0);
}

export function captionDocumentProblems(document: CaptionDocument): string[] {
  const problems: string[] = [];
  const wordDuplicate = duplicateIds(document.words.map((word) => word.id));
  if (wordDuplicate) problems.push(`Word id ${wordDuplicate} appears twice.`);
  const phraseDuplicate = duplicateIds(document.phrases.map((phrase) => phrase.id));
  if (phraseDuplicate) problems.push(`Phrase id ${phraseDuplicate} appears twice.`);
  const coverage = phraseCoverageProblem(document);
  if (coverage) problems.push(coverage);
  const timing = timingProblem(document);
  if (timing) problems.push(timing);
  if (document.words.some((word) => !word.hidden && !word.text.trim())) problems.push("Visible words need text.");
  const ids = [...document.words.map((word) => word.id), ...document.phrases.map((phrase) => phrase.id)];
  if (document.nextId <= highestNumber(ids)) problems.push("The next id must be above every existing id.");
  return problems;
}

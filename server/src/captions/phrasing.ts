import { captionTextLength, hasTranscriptSpace, isUnspacedText, joinsWithoutSpace } from "./script.js";

export interface PhraseWord {
  id: string;
  text: string;
  start: number;
  end: number;
}

const PHRASE_LIMITS = {
  gapSeconds: 0.45,
  maxWords: 7,
  maxChars: 28,
  maxSeconds: 3.2,
  commaMinWords: 4,
} as const;

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/u;
const CLAUSE_END = /[,;:，、；：]["'”’)\]]*$/u;

function startsRun(run: readonly PhraseWord[], word: PhraseWord): boolean {
  const last = run.at(-1);
  if (!last) return false;
  return word.start - last.end >= PHRASE_LIMITS.gapSeconds
    || (hasTranscriptSpace(last.text) && joinsWithoutSpace(last.text, word.text));
}

function endsRun(run: readonly PhraseWord[], word: PhraseWord): boolean {
  const text = word.text.trim();
  return SENTENCE_END.test(text) || (CLAUSE_END.test(text) && run.length >= PHRASE_LIMITS.commaMinWords);
}

function runs(words: readonly PhraseWord[]): PhraseWord[][] {
  const result: PhraseWord[][] = [];
  let run: PhraseWord[] = [];
  for (const word of words) {
    if (startsRun(run, word)) {
      result.push(run);
      run = [];
    }
    run.push(word);
    if (endsRun(run, word)) {
      result.push(run);
      run = [];
    }
  }
  if (run.length > 0) result.push(run);
  return result;
}

function load(phrase: readonly PhraseWord[]): number {
  const spacedWords = phrase.filter((word) => !isUnspacedText(word.text)).length;
  const columns = Math.max(phrase.length, captionTextLength(phrase.map((word) => word.text.trim())));
  const seconds = phrase[phrase.length - 1].end - phrase[0].start;
  return Math.max(spacedWords / PHRASE_LIMITS.maxWords, columns / PHRASE_LIMITS.maxChars, seconds / PHRASE_LIMITS.maxSeconds);
}

interface Split {
  count: number;
  worst: number;
  start: number;
}

function better(candidate: Split, current: Split | null): boolean {
  if (!current) return true;
  return candidate.count < current.count || (candidate.count === current.count && candidate.worst <= current.worst);
}

function bestSplitEndingAt(run: readonly PhraseWord[], splits: readonly Split[], end: number): Split {
  let best: Split | null = null;
  for (let start = end - 1; start >= 0; start -= 1) {
    const cost = load(run.slice(start, end));
    if (cost > 1 && start < end - 1) break;
    const candidate = { count: splits[start].count + 1, worst: Math.max(splits[start].worst, cost), start };
    if (better(candidate, best)) best = candidate;
  }
  return best!;
}

function balancedPhrases(run: readonly PhraseWord[]): PhraseWord[][] {
  const splits: Split[] = [{ count: 0, worst: 0, start: 0 }];
  for (let end = 1; end <= run.length; end += 1) splits.push(bestSplitEndingAt(run, splits, end));
  const phrases: PhraseWord[][] = [];
  for (let end = run.length; end > 0; end = splits[end].start) phrases.unshift(run.slice(splits[end].start, end));
  return phrases;
}

export function groupPhrases(words: readonly PhraseWord[]): string[][] {
  return runs(words).flatMap(balancedPhrases).map((phrase) => phrase.map((word) => word.id));
}

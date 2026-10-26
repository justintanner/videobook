import { captionTextLength, isUnspacedText } from "./script.js";

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
  maxUnspacedChars: 14,
  maxSeconds: 3.2,
  commaMinWords: 4,
} as const;

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/u;
const CLAUSE_END = /[,;:，、；：]["'”’)\]]*$/u;

function charLimit(words: readonly PhraseWord[], next: PhraseWord): number {
  const unspaced = words.some((word) => isUnspacedText(word.text)) || isUnspacedText(next.text);
  return unspaced ? PHRASE_LIMITS.maxUnspacedChars : PHRASE_LIMITS.maxChars;
}

function breaksBefore(current: readonly PhraseWord[], word: PhraseWord): boolean {
  const last = current.at(-1);
  if (!last) return false;
  const first = current[0];
  return word.start - last.end >= PHRASE_LIMITS.gapSeconds
    || current.length >= PHRASE_LIMITS.maxWords
    || captionTextLength([...current, word].map((item) => item.text)) > charLimit(current, word)
    || word.end - first.start > PHRASE_LIMITS.maxSeconds;
}

function breaksAfter(current: readonly PhraseWord[], word: PhraseWord): boolean {
  const text = word.text.trim();
  return SENTENCE_END.test(text) || (CLAUSE_END.test(text) && current.length >= PHRASE_LIMITS.commaMinWords);
}

export function groupPhrases(words: readonly PhraseWord[]): string[][] {
  const groups: string[][] = [];
  let current: PhraseWord[] = [];
  for (const word of words) {
    if (breaksBefore(current, word)) {
      groups.push(current.map((item) => item.id));
      current = [];
    }
    current.push(word);
    if (breaksAfter(current, word)) {
      groups.push(current.map((item) => item.id));
      current = [];
    }
  }
  if (current.length > 0) groups.push(current.map((item) => item.id));
  return groups;
}

import type { CaptionDocument, CaptionStyle, CaptionWord } from "./model.js";
import { MIN_CAPTION_WORD_SECONDS } from "./model.js";

export interface TimedCaptionWord {
  id: string;
  text: string;
  start: number;
  end: number;
  energy: number;
}

export interface CaptionCue {
  phraseId: string;
  index: number;
  start: number;
  end: number;
  words: TimedCaptionWord[];
}

const LEAD_SECONDS = 0.06;
const HOLD_SECONDS = 0.6;
const MIN_CUE_SECONDS = 0.1;
const DEFAULT_ENERGY = 0.5;

type TimingStyle = Pick<CaptionStyle, "snapToOnsets" | "offsetMs">;

function onsetShift(word: CaptionWord, style: TimingStyle): number {
  if (word.timingCorrected || !word.analysed || !style.snapToOnsets) return 0;
  return word.analysed.onset - word.analysed.start;
}

export function effectiveWordTiming(word: CaptionWord, style: TimingStyle): { start: number; end: number } {
  const shift = onsetShift(word, style) + style.offsetMs / 1000;
  const start = Math.max(0, word.start + shift);
  const end = Math.max(start + MIN_CAPTION_WORD_SECONDS, word.end + shift);
  return { start, end };
}

function timedWord(word: CaptionWord, style: TimingStyle): TimedCaptionWord {
  return {
    id: word.id,
    text: word.text,
    ...effectiveWordTiming(word, style),
    energy: word.analysed?.energy ?? DEFAULT_ENERGY,
  };
}

interface PhraseWords {
  phraseId: string;
  words: TimedCaptionWord[];
}

function visiblePhraseWords(document: CaptionDocument): PhraseWords[] {
  const byId = new Map(document.words.map((word) => [word.id, word]));
  return document.phrases
    .map((phrase) => ({
      phraseId: phrase.id,
      words: phrase.wordIds
        .map((id) => byId.get(id))
        .filter((word): word is CaptionWord => Boolean(word && !word.hidden && word.text.trim()))
        .map((word) => timedWord(word, document.style)),
    }))
    .filter((entry) => entry.words.length > 0);
}

function cueFor(entry: PhraseWords, next: PhraseWords | undefined, index: number): CaptionCue {
  const first = entry.words[0];
  const last = entry.words[entry.words.length - 1];
  const start = Math.max(0, first.start - LEAD_SECONDS);
  const hold = last.end + HOLD_SECONDS;
  const end = next ? Math.min(hold, next.words[0].start - LEAD_SECONDS) : hold;
  return { phraseId: entry.phraseId, index, start, end: Math.max(end, start + MIN_CUE_SECONDS), words: entry.words };
}

export function captionCues(document: CaptionDocument): CaptionCue[] {
  const entries = visiblePhraseWords(document);
  return entries.map((entry, index) => cueFor(entry, entries[index + 1], index));
}

export function activeCaptionCue(cues: readonly CaptionCue[], time: number): CaptionCue | null {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cue = cues[middle];
    if (time < cue.start) high = middle - 1;
    else if (time >= cue.end) low = middle + 1;
    else return cue;
  }
  return null;
}

export function activeCaptionWord(cue: CaptionCue, time: number): TimedCaptionWord | null {
  let active: TimedCaptionWord | null = null;
  for (const word of cue.words) {
    if (word.start <= time) active = word;
    else break;
  }
  return active;
}

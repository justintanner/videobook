import { joinCaptionWords, joinsWithoutSpace } from "../../captions/script.js";
import type { TranscriptToken } from "../../transcript-words.js";
import { joinUnspacedLetters } from "../../transcript-words.js";
import type { Segment, Word } from "./types.js";

interface ElevenLabsWord {
  text?: string;
  word?: string;
  start?: number;
  end?: number;
  type?: string;
}

interface ElevenLabsSegment {
  text?: string;
  start?: number;
  end?: number;
  words?: ElevenLabsWord[];
}

interface ElevenLabsJson {
  segments?: ElevenLabsSegment[];
  words?: ElevenLabsWord[];
}

export function parseSegments(data: ElevenLabsJson): Segment[] {
  if (data.segments && data.segments.length > 0) {
    return data.segments.flatMap(parseOneSegment);
  }

  if (data.words && data.words.length > 0) {
    return spokenClauses(data.words).map(clauseSegment);
  }

  return [];
}

function parseOneSegment(seg: ElevenLabsSegment): Segment[] {
  const clauses = spokenClauses(seg.words ?? []);
  if (clauses.length > 1) return clauses.map(clauseSegment);
  return [{
    start: seg.start ?? 0,
    end: seg.end ?? 0,
    text: (seg.text ?? "").trim(),
    words: clauses[0] ?? [],
  }];
}

function clauseSegment(words: Word[]): Segment {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: joinCaptionWords(words.map((w) => w.word)),
    words,
  };
}

function tokenOf(w: ElevenLabsWord): TranscriptToken {
  return { text: w.text ?? w.word ?? "", start: w.start ?? 0, end: w.end ?? 0, type: w.type ?? "word" };
}

function spokenClauses(raw: readonly ElevenLabsWord[]): Word[][] {
  const clauses: Word[][] = [[]];
  let separated = false;
  for (const token of joinUnspacedLetters(raw.map(tokenOf))) {
    if (token.type !== "word") {
      separated = true;
      continue;
    }
    const word = parseOneWord(token);
    if (!word) continue;
    const clause = clauses[clauses.length - 1];
    const previous = clause.at(-1);
    if (previous && separated && joinsWithoutSpace(previous.word, word.word)) clauses.push([word]);
    else clause.push(word);
    separated = false;
  }
  return clauses.filter((clause) => clause.length > 0);
}

function parseOneWord(w: ElevenLabsWord): Word | null {
  const text = (w.text ?? w.word ?? "").trim();
  if (!text) return null;
  return {
    word: text,
    start: w.start ?? 0,
    end: w.end ?? 0,
  };
}

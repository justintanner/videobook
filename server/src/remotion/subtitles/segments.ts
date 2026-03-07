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
    return data.segments.map(parseOneSegment);
  }

  if (data.words && data.words.length > 0) {
    const words = data.words
      .filter((w) => (w.type ?? "word") === "word")
      .map(parseOneWord)
      .filter((w): w is Word => w !== null);

    if (words.length === 0) return [];

    return [{
      start: words[0].start,
      end: words[words.length - 1].end,
      text: words.map((w) => w.word).join(" "),
      words,
    }];
  }

  return [];
}

function parseOneSegment(seg: ElevenLabsSegment): Segment {
  const words = (seg.words ?? [])
    .filter((w) => (w.type ?? "word") === "word")
    .map(parseOneWord)
    .filter((w): w is Word => w !== null);

  return {
    start: seg.start ?? 0,
    end: seg.end ?? 0,
    text: (seg.text ?? "").trim(),
    words,
  };
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

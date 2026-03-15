import type { Segment, Chunk, Word, Orientation, SubtitleStyle } from "./types.js";

const CHUNK_LIMITS: Record<string, [number, number]> = {
  "highlight:portrait": [40, 8],
  "highlight:landscape": [60, 12],
  "highlight:square": [60, 12],
  "tikdance:portrait": [16, 3],
  "tikdance:landscape": [30, 5],
  "tikdance:square": [30, 5],
};

const MAX_DURATION = 6.0;

function getChunkLimits(style: SubtitleStyle, orientation: Orientation): [number, number] {
  return CHUNK_LIMITS[`${style}:${orientation}`] ?? [42, 8];
}

export function chunkSegments(
  segments: Segment[],
  orientation: Orientation = "portrait",
  style: SubtitleStyle = "tikdance",
): Chunk[] {
  const [maxChars, maxWords] = getChunkLimits(style, orientation);
  const chunked: Chunk[] = [];

  for (const segment of segments) {
    const words = segment.words;
    if (words.length === 0) {
      const text = segment.text.trim();
      if (text) {
        chunked.push({ start: segment.start, end: segment.end, text, words: [] });
      }
      continue;
    }

    let currentWords: Word[] = [];
    let chunkStart: number | null = null;

    for (let idx = 0; idx < words.length; idx++) {
      const word = words[idx];
      if (chunkStart === null) {
        chunkStart = word.start;
      }

      const potentialText = [...currentWords, word].map((w) => w.word.trim()).join(" ");
      const potentialDuration = word.end - chunkStart;
      const wouldExceed =
        currentWords.length >= maxWords ||
        potentialText.length > maxChars ||
        potentialDuration > MAX_DURATION;

      if (wouldExceed && currentWords.length > 0) {
        const chunkText = currentWords.map((w) => w.word.trim()).join(" ");
        const chunkEnd = currentWords[currentWords.length - 1].end;
        chunked.push({
          start: chunkStart,
          end: chunkEnd,
          text: chunkText.trim(),
          words: [...currentWords],
        });
        currentWords = [];
        chunkStart = word.start;
      }

      currentWords.push(word);

      const wordText = word.word.trim();
      const isSentenceEnd = wordText.endsWith(".") || wordText.endsWith("!") || wordText.endsWith("?");
      const isLast = idx === words.length - 1;

      if ((isSentenceEnd || isLast) && currentWords.length > 0) {
        const chunkText = currentWords.map((w) => w.word.trim()).join(" ");
        const chunkEnd = currentWords[currentWords.length - 1].end;
        chunked.push({
          start: chunkStart!,
          end: chunkEnd,
          text: chunkText.trim(),
          words: [...currentWords],
        });
        currentWords = [];
        chunkStart = null;
      }
    }
  }

  return chunked;
}

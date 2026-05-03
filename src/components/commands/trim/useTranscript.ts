import { useEffect, useState } from 'react';
import type { TranscriptWord } from './types';

interface ElevenLabsWord {
  text?: string;
  word?: string;
  start?: number;
  end?: number;
  type?: string;
}

interface ElevenLabsSegment {
  words?: ElevenLabsWord[];
}

interface ElevenLabsJson {
  segments?: ElevenLabsSegment[];
  words?: ElevenLabsWord[];
}

function parseTranscriptWords(data: ElevenLabsJson): TranscriptWord[] {
  const rawWords: ElevenLabsWord[] = [];

  if (data.segments && data.segments.length > 0) {
    for (const seg of data.segments) {
      if (seg.words) rawWords.push(...seg.words);
    }
  } else if (data.words) {
    rawWords.push(...data.words);
  }

  return rawWords
    .filter((w) => (w.type ?? 'word') === 'word')
    .map((w) => {
      const text = (w.text ?? w.word ?? '').trim();
      if (!text) return null;
      return { text, start: w.start ?? 0, end: w.end ?? 0 };
    })
    .filter((w): w is TranscriptWord => w !== null);
}

export function useTranscript(
  open: boolean,
  assetId: string | null,
  projectSlug: string | undefined,
): TranscriptWord[] {
  const [words, setWords] = useState<TranscriptWord[]>([]);

  useEffect(() => {
    if (!open || !assetId || !projectSlug) {
      return () => setWords([]);
    }
    let cancelled = false;
    fetch(`/files/${projectSlug}/${assetId}/elevenlabs.json`)
      .then((res) => {
        if (!res.ok) throw new Error('no transcript');
        return res.json() as Promise<ElevenLabsJson>;
      })
      .then((data) => {
        if (!cancelled) setWords(parseTranscriptWords(data));
      })
      .catch(() => {
        if (!cancelled) setWords([]);
      });
    return () => { cancelled = true; };
  }, [open, assetId, projectSlug]);

  return words;
}

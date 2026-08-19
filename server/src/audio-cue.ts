type TimedSpeechWord = {
  text: string;
  start: number;
};

type TranscriptWord = {
  text?: unknown;
  start?: unknown;
  type?: unknown;
};

function transcriptWords(transcript: Record<string, unknown>): unknown {
  if (Array.isArray(transcript.words)) return transcript.words;
  const transcripts = transcript.transcripts;
  if (!Array.isArray(transcripts) || transcripts.length === 0) return undefined;
  const first = transcripts[0];
  return typeof first === "object" && first !== null
    ? (first as Record<string, unknown>).words
    : undefined;
}

function cueTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\u2019']/gu, "")
    .split(/[^\p{L}\p{N}]+/gu)
    .filter(Boolean);
}

export function timedSpeechWords(transcript: unknown): TimedSpeechWord[] {
  if (typeof transcript !== "object" || transcript === null) {
    throw new Error("elevenlabs.json must contain a JSON object");
  }
  const words = transcriptWords(transcript as Record<string, unknown>);
  if (!Array.isArray(words)) {
    throw new Error("elevenlabs.json does not contain timed words");
  }

  const result: TimedSpeechWord[] = [];
  for (const entry of words as TranscriptWord[]) {
    if ((entry.type ?? "word") !== "word") continue;
    if (typeof entry.text !== "string") continue;
    if (typeof entry.start !== "number" || !Number.isFinite(entry.start) || entry.start < 0) continue;
    const tokens = cueTokens(entry.text);
    for (const token of tokens) result.push({ text: token, start: entry.start });
  }
  return result;
}

export function hasTimedSpeechWords(transcript: unknown): boolean {
  try {
    return timedSpeechWords(transcript).length > 0;
  } catch {
    return false;
  }
}

function timestampList(matches: number[]): string {
  return matches.map((seconds) => `${Number(seconds.toFixed(3))}s`).join(", ");
}

export function resolveAudioCue(transcript: unknown, cue: string): number {
  const query = cueTokens(cue);
  if (query.length === 0) throw new Error("Audio cue must contain a word or number");

  const words = timedSpeechWords(transcript);
  const matches: number[] = [];
  for (let start = 0; start + query.length <= words.length; start++) {
    const matchesPhrase = query.every((token, offset) => words[start + offset]?.text === token);
    if (matchesPhrase) matches.push(words[start].start);
  }

  if (matches.length === 0) {
    throw new Error(`Audio cue "${cue}" was not found in elevenlabs.json. Use audio_seconds for a numeric target.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Audio cue "${cue}" is ambiguous; it matches at ${timestampList(matches)}. Use a longer phrase or audio_seconds.`,
    );
  }
  return matches[0];
}

import type { ElevenLabsSpeechToTextResponse } from "@apicity/elevenlabs";

export const ELEVENLABS_SCRIBE_MODEL = "scribe_v2";
export const ELEVENLABS_SOUND_EFFECT_MODEL = "eleven_text_to_sound_v2";
export const ELEVENLABS_SOUND_EFFECT_OUTPUT_FORMAT = "mp3_44100_128";
export const AUDIO_CROSSFADE_MS = 500;
export const MIN_AUDIO_CONTINUATION_MS = 500;
export const MAX_AUDIO_CONTINUATION_MS = 29_500;
export const MAX_SOUND_GENERATION_PROMPT_CHARS = 450;
export const MAX_CONTINUATION_DIRECTION_CHARS = 250;

const MAX_SOURCE_CONTEXT_CHARS = 100;
const MIN_SOURCE_CONTEXT_CHARS = 20;

export function normalizeContinuationPrompt(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const wrapped = /^\(([^()]*)\)$/.exec(trimmed);
  const direction = (wrapped ? wrapped[1] : trimmed).trim();
  return direction || undefined;
}

function transcriptText(response: ElevenLabsSpeechToTextResponse): string {
  if ("text" in response && typeof response.text === "string") {
    return response.text;
  }
  if ("transcripts" in response && Array.isArray(response.transcripts)) {
    return response.transcripts.map((transcript) => transcript.text).join(" ");
  }
  return "";
}

export function describeSourceAudio(response: ElevenLabsSpeechToTextResponse): string {
  const description = transcriptText(response)
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return description.slice(0, 1_000) || "the same sound and ambient texture as the source audio";
}

export function buildSoundContinuationPrompt(
  sourceDescription: string,
  generationDurationSeconds: number,
  continuationPrompt?: string,
): string {
  const duration = generationDurationSeconds.toFixed(1);
  const direction = normalizeContinuationPrompt(continuationPrompt)
    ?.slice(0, MAX_CONTINUATION_DIRECTION_CHARS)
    .replace(/[.!?\s]+$/, "");
  if (!direction) {
    return [
      `Continue this audio seamlessly for ${duration}s: ${sourceDescription.slice(0, MAX_SOURCE_CONTEXT_CHARS)}.`,
      "Start immediately mid-action and match its character, setting, intensity, tone, and perspective.",
      "Repeat or vary the source event naturally so matching sound fills the duration.",
      "Keep matching activity and ambience audible through the final second.",
      "No intro, unrelated sound, fade-in, early ending, or silent tail.",
    ].join(" ").slice(0, MAX_SOUND_GENERATION_PROMPT_CHARS);
  }

  // Direction leads so the 450-char cap can only ever trim source context or
  // closing guidance, never the user's requested change.
  const lead = `Continue this audio for ${duration}s: ${direction}.`;
  const close = "Transition smoothly from the source, follow the direction for the full duration, and keep it audible through the final second with no silent tail.";
  const sourceLabel = "Source audio: ";
  const sourceBudget = MAX_SOUND_GENERATION_PROMPT_CHARS
    - lead.length - close.length - sourceLabel.length - " .".length - 1;
  const source = sourceBudget >= MIN_SOURCE_CONTEXT_CHARS
    ? sourceDescription.slice(0, Math.min(MAX_SOURCE_CONTEXT_CHARS, sourceBudget))
    : "";
  const context = source ? ` ${sourceLabel}${source}.` : "";
  return `${lead}${context} ${close}`.slice(0, MAX_SOUND_GENERATION_PROMPT_CHARS);
}

export function audioCrossfadeMs(sourceDurationMs: number, continuationDurationMs: number): number {
  return Math.max(
    1,
    Math.min(
      AUDIO_CROSSFADE_MS,
      Math.floor(sourceDurationMs / 2),
      Math.floor(continuationDurationMs / 2),
    ),
  );
}

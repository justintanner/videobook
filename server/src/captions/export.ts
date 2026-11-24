import { phraseTranslationTexts } from "./lines.js";
import type { CaptionDocument, CaptionPhrase } from "./model.js";
import { captionDisplayLanguage } from "./model.js";
import type { CaptionCue } from "./timing.js";
import { captionCues } from "./timing.js";
import { captionCase, joinCaptionWords } from "./script.js";

export type CaptionExportFormat = "srt" | "vtt";

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function timestamp(seconds: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${separator}${pad(totalMs % 1000, 3)}`;
}

function cueText(document: CaptionDocument, cue: CaptionCue, phrase: CaptionPhrase | undefined): string {
  const uppercase = document.style.uppercase;
  const spoken = captionCase(joinCaptionWords(cue.words.map((word) => word.text)), uppercase, captionDisplayLanguage(document));
  const translated = phraseTranslationTexts(document, phrase).map(({ language, text }) => captionCase(text, uppercase, language));
  return [spoken, ...translated].join("\n");
}

function cueTexts(document: CaptionDocument): Array<{ start: number; end: number; text: string }> {
  const phrases = new Map(document.phrases.map((phrase) => [phrase.id, phrase]));
  return captionCues(document).map((cue) => ({
    start: cue.words[0].start,
    end: Math.max(cue.words[cue.words.length - 1].end, cue.words[0].start + 0.1),
    text: cueText(document, cue, phrases.get(cue.phraseId)),
  }));
}

export function captionsToSubtitleFile(document: CaptionDocument, format: CaptionExportFormat): string {
  const cues = cueTexts(document);
  if (format === "srt") {
    return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}\n${cue.text}\n`).join("\n");
  }
  const body = cues.map((cue) => `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}\n${cue.text}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

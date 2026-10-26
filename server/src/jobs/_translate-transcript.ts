import { createHash } from "node:crypto";
import { isUnspacedText, joinCaptionWords, joinsWithoutSpace } from "../captions/script.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import type { Segment, Word } from "../remotion/subtitles/types.js";
import {
  INTELLIGENCE_MODEL,
  firstResponseText,
  intelligenceRequest,
  type ResponsesFn,
} from "../openai-intelligence.js";
import { SUBTITLE_LANGUAGE_NAMES } from "../subtitle-languages.js";
import { splitUnspacedText } from "../transcript-words.js";

const TRANSLATION_MODEL = INTELLIGENCE_MODEL;

type SidecarWord = {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing";
};

type SidecarSegment = {
  start: number;
  end: number;
  text: string;
  words: SidecarWord[];
};

type TranslatedSidecar = {
  sourceLanguageCode: string | null;
  targetLanguage: string;
  model: string;
  translatedAt: string;
  sourceTextHash: string;
  segments: SidecarSegment[];
};

type SourceSentence = {
  start: number;
  end: number;
  text: string;
};

// Subtitle language setting: 'original' (use the source transcript) or an
// ISO 639-1 code naming the translation target.
export function isLanguageSetting(value: unknown): value is string {
  return typeof value === "string" && (value === "original" || /^[a-z]{2}$/.test(value));
}

export function translatedTranscriptFilename(language: string): string {
  return `elevenlabs.${language}.json`;
}

// ElevenLabs scribe reports language_code in ISO 639-3; the UI setting uses
// ISO 639-1. Covers the curated language list plus common detection results.
const ISO3_TO_ISO1: Record<string, string> = {
  eng: "en",
  zho: "zh",
  cmn: "zh",
  yue: "zh",
  spa: "es",
  por: "pt",
  fra: "fr",
  deu: "de",
  ita: "it",
  nld: "nl",
  pol: "pl",
  rus: "ru",
  tur: "tr",
  ara: "ar",
  hin: "hi",
  ind: "id",
  jpn: "ja",
  kor: "ko",
  vie: "vi",
  tha: "th",
  ukr: "uk",
  swe: "sv",
  dan: "da",
  nor: "no",
  fin: "fi",
  ces: "cs",
  ell: "el",
  heb: "he",
  hun: "hu",
  ron: "ro",
};

const LANGUAGE_NAMES = SUBTITLE_LANGUAGE_NAMES;

export function iso1FromIso3(code: string | null | undefined): string | null {
  if (!code) return null;
  return ISO3_TO_ISO1[code.toLowerCase()] ?? null;
}

export function readLanguageCode(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const code = (raw as { language_code?: unknown }).language_code;
  return typeof code === "string" ? code : null;
}

// ── Sentence grouping ──
//
// The split exists only to preserve subtitle timing: each sentence carries the
// time window of its source words, and the translated sentence inherits it.
// Translation itself always sees the full transcript in one request.

const SENTENCE_END_RE = /[.!?。！？…]["'"』」)]*$/;
const MAX_SENTENCE_WORDS = 30;
const PAUSE_GAP_SECONDS = 0.8;

export function groupIntoSentences(words: Word[]): SourceSentence[] {
  const sentences: SourceSentence[] = [];
  let current: Word[] = [];

  const flush = () => {
    const texts = current.map((w) => w.word.trim()).filter((t) => t.length > 0);
    if (texts.length > 0) {
      sentences.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: joinCaptionWords(texts),
      });
    }
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);
    const next = words[i + 1];
    const sentenceEnd = SENTENCE_END_RE.test(word.word.trim());
    const longPause = next !== undefined && next.start - word.end > PAUSE_GAP_SECONDS;
    if (sentenceEnd || longPause || current.length >= MAX_SENTENCE_WORDS) flush();
  }
  flush();

  return sentences;
}

// ── Word-timing synthesis for translated text ──

type TimingToken = {
  text: string;
  spaceBefore: boolean;
};

function tokenizeForTiming(text: string): TimingToken[] {
  return text.split(/\s+/u).filter((chunk) => chunk.length > 0).flatMap((chunk) => {
    const parts = isUnspacedText(chunk) ? splitUnspacedText(chunk) : [chunk];
    return parts.map((part, index) => ({ text: part, spaceBefore: index === 0 }));
  });
}

function keepsSpace(tokens: readonly TimingToken[], index: number): boolean {
  return index > 0 && tokens[index].spaceBefore && joinsWithoutSpace(tokens[index - 1].text, tokens[index].text);
}

export function synthesizeWordTimings(text: string, start: number, end: number): SidecarWord[] {
  const tokens = tokenizeForTiming(text);
  if (tokens.length === 0) return [];
  const weights = tokens.map((t) => Math.max(1, t.text.length));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const duration = Math.max(0, end - start);

  const words: SidecarWord[] = [];
  let consumed = 0;
  for (let i = 0; i < tokens.length; i++) {
    const wordStart = start + (duration * consumed) / totalWeight;
    consumed += weights[i];
    const wordEnd = start + (duration * consumed) / totalWeight;
    if (keepsSpace(tokens, i)) words.push({ text: " ", start: wordStart, end: wordStart, type: "spacing" });
    words.push({ text: tokens[i].text, start: wordStart, end: wordEnd, type: "word" });
  }
  return words;
}

// ── Cache invalidation hash ──

export function computeSourceTextHash(segments: Segment[]): string {
  const hash = createHash("sha1");
  for (const segment of segments) {
    if (segment.words.length > 0) {
      for (const word of segment.words) hash.update(`${word.word.trim()}\n`);
    } else {
      hash.update(`${segment.text.trim()}\n`);
    }
  }
  return hash.digest("hex").slice(0, 12);
}

// ── Translation ──

function buildInstructions(targetLanguage: string, lineCount: number): string {
  const languageName = LANGUAGE_NAMES[targetLanguage] ?? targetLanguage;
  return (
    "You translate video subtitles. The user message contains the FULL transcript of one video " +
    "as a JSON array of numbered lines, in spoken order. Translate the dialog as one coherent " +
    `whole into ${languageName}: natural conversational phrasing, with names, pronouns, and ` +
    "terminology kept consistent across lines.\n\n" +
    `Return ONLY a JSON object {"translations": [...]} containing exactly ${lineCount} strings — ` +
    "translation i corresponds to line i. Do not merge, split, reorder, or omit lines. " +
    "No romanization, no notes, no text outside the JSON."
  );
}

async function requestTranslations(
  sentences: SourceSentence[],
  targetLanguage: string,
  responses: ResponsesFn,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await responses(intelligenceRequest({
    instructions: buildInstructions(targetLanguage, sentences.length),
    input: [{
      role: "user",
      content: `TRANSCRIPT LINES (JSON):\n${JSON.stringify(sentences.map((s, i) => ({ i, text: s.text })))}`,
    }],
    text: {
      format: {
        type: "json_schema",
        name: "translated_transcript",
        schema: {
          type: "object",
          required: ["translations"],
          additionalProperties: false,
          properties: {
            translations: {
              type: "array",
              minItems: sentences.length,
              maxItems: sentences.length,
              items: { type: "string" },
            },
          },
        },
        strict: true,
      },
    },
    max_output_tokens: 4096,
  }), signal);

  const content = firstResponseText(response);
  if (!content) {
    throw new Error(`Translation provider returned no content (status=${response.status})`);
  }
  const parsed = JSON.parse(content) as { translations?: unknown };
  if (!Array.isArray(parsed.translations)) {
    throw new Error(`Translation model returned no translations array. Got keys: ${Object.keys(parsed).join(",")}`);
  }
  const translations = parsed.translations;
  if (translations.length !== sentences.length || !translations.every((t) => typeof t === "string")) {
    throw new Error(
      `Translation model returned ${translations.length} entries for ${sentences.length} lines`,
    );
  }
  return (translations as string[]).map((t) => t.trim());
}

function collectSentences(segments: Segment[]): SourceSentence[] {
  const sentences: SourceSentence[] = [];
  for (const segment of segments) {
    if (segment.words.length > 0) {
      sentences.push(...groupIntoSentences(segment.words));
    } else if (segment.text.trim().length > 0) {
      sentences.push({ start: segment.start, end: segment.end, text: segment.text.trim() });
    }
  }
  return sentences;
}

export async function translateTranscript(
  raw: unknown,
  targetLanguage: string,
  responses: ResponsesFn,
  signal?: AbortSignal,
): Promise<TranslatedSidecar> {
  const sourceSegments = parseSegments(raw as Parameters<typeof parseSegments>[0]);
  const sentences = collectSentences(sourceSegments);
  if (sentences.length === 0) {
    throw new Error("Transcript contains no subtitle text to translate");
  }

  const translations = await requestTranslations(sentences, targetLanguage, responses, signal);

  const segments: SidecarSegment[] = sentences.map((sentence, i) => ({
    start: sentence.start,
    end: sentence.end,
    text: translations[i],
    words: synthesizeWordTimings(translations[i], sentence.start, sentence.end),
  }));

  return {
    sourceLanguageCode: readLanguageCode(raw),
    targetLanguage,
    model: TRANSLATION_MODEL,
    translatedAt: new Date().toISOString(),
    sourceTextHash: computeSourceTextHash(sourceSegments),
    segments,
  };
}

// True when an existing sidecar was produced from the current transcript and
// can be served as-is.
export function sidecarMatchesSource(sidecar: unknown, sourceSegments: Segment[]): boolean {
  if (typeof sidecar !== "object" || sidecar === null) return false;
  const hash = (sidecar as { sourceTextHash?: unknown }).sourceTextHash;
  return typeof hash === "string" && hash === computeSourceTextHash(sourceSegments);
}

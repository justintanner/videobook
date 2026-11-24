import type { CaptionDocument, CaptionPhrase, CaptionPhraseTranslations, CaptionWord } from "./model.js";
import { joinCaptionWords } from "./script.js";

export type CaptionLineMemory = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface CaptionLineSource {
  phraseId: string;
  source: string;
}

export interface CaptionResolvedLine {
  phraseId: string;
  source: string;
  text: string | null;
  edited: boolean;
}

function visibleText(phrase: CaptionPhrase, words: ReadonlyMap<string, CaptionWord>): string {
  const texts = phrase.wordIds
    .map((id) => words.get(id))
    .filter((word): word is CaptionWord => Boolean(word && !word.hidden && word.text.trim()))
    .map((word) => word.text.trim());
  return joinCaptionWords(texts);
}

export function captionLineSources(document: CaptionDocument): CaptionLineSource[] {
  const words = new Map(document.words.map((word) => [word.id, word]));
  return document.phrases.flatMap((phrase) => {
    const source = visibleText(phrase, words);
    return source ? [{ phraseId: phrase.id, source }] : [];
  });
}

export function captionTranslationLanguages(document: CaptionDocument): string[] {
  return (document.translations ?? []).map((line) => line.language);
}

export function rememberedLine(memory: CaptionLineMemory, language: string, source: string): string | undefined {
  const lines = Object.hasOwn(memory, language) ? memory[language] : undefined;
  return lines && Object.hasOwn(lines, source) ? lines[source] : undefined;
}

function phraseLine(phrase: CaptionPhrase | undefined, language: string): string | undefined {
  const own = phrase?.translations;
  return own && Object.hasOwn(own, language) ? own[language] : undefined;
}

export function resolvedCaptionLines(document: CaptionDocument, language: string, memory: CaptionLineMemory): CaptionResolvedLine[] {
  const phrases = new Map(document.phrases.map((phrase) => [phrase.id, phrase]));
  return captionLineSources(document).map(({ phraseId, source }) => {
    const edited = phraseLine(phrases.get(phraseId), language);
    const text = edited ?? rememberedLine(memory, language, source) ?? null;
    return { phraseId, source, text, edited: edited !== undefined };
  });
}

export function missingCaptionLines(document: CaptionDocument, language: string, memory: CaptionLineMemory): string[] {
  const missing = resolvedCaptionLines(document, language, memory).filter((line) => line.text === null).map((line) => line.source);
  return [...new Set(missing)];
}

function resolvedTranslations(phrase: CaptionPhrase, source: string, languages: readonly string[], memory: CaptionLineMemory): CaptionPhraseTranslations {
  const entries = languages.flatMap((language) => {
    const text = phraseLine(phrase, language) ?? rememberedLine(memory, language, source);
    return text === undefined ? [] : [[language, text] as const];
  });
  return Object.fromEntries(entries);
}

function withTranslations(phrase: CaptionPhrase, translations: CaptionPhraseTranslations): CaptionPhrase {
  const { translations: _own, ...rest } = phrase;
  return Object.keys(translations).length > 0 ? { ...rest, translations } : rest;
}

export function resolveCaptionTranslations(document: CaptionDocument, memory: CaptionLineMemory): CaptionDocument {
  const languages = captionTranslationLanguages(document);
  if (languages.length === 0) return document;
  const sources = new Map(captionLineSources(document).map((line) => [line.phraseId, line.source]));
  return {
    ...document,
    phrases: document.phrases.map((phrase) => {
      const source = sources.get(phrase.id);
      return withTranslations(phrase, source === undefined ? {} : resolvedTranslations(phrase, source, languages, memory));
    }),
  };
}

export function phraseTranslationTexts(document: CaptionDocument, phrase: CaptionPhrase | undefined): Array<{ language: string; text: string }> {
  return (document.translations ?? []).flatMap(({ language }) => {
    const text = phraseLine(phrase, language)?.trim();
    return text ? [{ language, text }] : [];
  });
}

import { useMemo } from "react";
import { captionFontStack } from "../../captions/fonts.js";
import type { CaptionBlock, CaptionRegionFrame } from "../../captions/layout.js";
import { layoutCaptions } from "../../captions/layout.js";
import { phraseTranslationTexts } from "../../captions/lines.js";
import type { CaptionDocument } from "../../captions/model.js";
import { captionDisplayLanguage } from "../../captions/model.js";
import { captionCase, captionScripts } from "../../captions/script.js";
import type { CaptionFontUrls } from "./caption-fonts.js";
import { measureCaptionText, useCaptionFonts } from "./caption-fonts.js";

function wordText(document: CaptionDocument): string[] {
  const language = captionDisplayLanguage(document);
  return document.words
    .filter((word) => !word.hidden)
    .map((word) => captionCase(word.text, document.style.uppercase, language));
}

function translationText(document: CaptionDocument): string[] {
  return document.phrases.flatMap((phrase) => phraseTranslationTexts(document, phrase)
    .map(({ language, text }) => captionCase(text, document.style.uppercase, language)));
}

function displayText(document: CaptionDocument): string {
  return [...wordText(document), ...translationText(document)].join(" ");
}

export interface CaptionLayoutState {
  ready: boolean;
  stack: string;
  blocks: CaptionBlock[];
}

export function useCaptionLayout(document: CaptionDocument, regions: readonly CaptionRegionFrame[], fontUrls: CaptionFontUrls): CaptionLayoutState {
  const text = useMemo(() => displayText(document), [document]);
  const scripts = useMemo(() => captionScripts(text, captionDisplayLanguage(document)), [text, document]);
  const ready = useCaptionFonts(fontUrls, scripts, text);
  const stack = useMemo(() => captionFontStack(document.style.preset, scripts), [document.style.preset, scripts]);
  const blocks = useMemo(
    () => (ready ? layoutCaptions({ document, regions, measure: (value, font) => measureCaptionText(value, font, stack) }) : []),
    [ready, document, regions, stack],
  );
  return { ready, stack, blocks };
}

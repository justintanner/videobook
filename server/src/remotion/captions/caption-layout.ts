import { useMemo } from "react";
import { captionFontStack } from "../../captions/fonts.js";
import type { CaptionBlock, CaptionRegionFrame } from "../../captions/layout.js";
import { layoutCaptions } from "../../captions/layout.js";
import type { CaptionDocument } from "../../captions/model.js";
import { captionCase, captionScripts } from "../../captions/script.js";
import type { CaptionFontUrls } from "./caption-fonts.js";
import { measureCaptionText, useCaptionFonts } from "./caption-fonts.js";

function captionLanguage(document: CaptionDocument): string | null {
  return document.language === "original" ? document.sourceLanguage : document.language;
}

function displayText(document: CaptionDocument): string {
  const language = captionLanguage(document);
  return document.words
    .filter((word) => !word.hidden)
    .map((word) => captionCase(word.text, document.style.uppercase, language))
    .join(" ");
}

export interface CaptionLayoutState {
  ready: boolean;
  stack: string;
  blocks: CaptionBlock[];
}

export function useCaptionLayout(document: CaptionDocument, regions: readonly CaptionRegionFrame[], fontUrls: CaptionFontUrls): CaptionLayoutState {
  const text = useMemo(() => displayText(document), [document]);
  const scripts = useMemo(() => captionScripts(text, captionLanguage(document)), [text, document]);
  const ready = useCaptionFonts(fontUrls, scripts, text);
  const stack = useMemo(() => captionFontStack(document.style.preset, scripts), [document.style.preset, scripts]);
  const blocks = useMemo(
    () => (ready ? layoutCaptions({ document, regions, measure: (value, font) => measureCaptionText(value, font, stack) }) : []),
    [ready, document, regions, stack],
  );
  return { ready, stack, blocks };
}

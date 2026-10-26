import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, staticFile } from "remotion";
import { BUNDLED_CAPTION_FONTS, CAPTION_FALLBACK_WEIGHT, captionScriptFamilies, googleTextSubsetUrl } from "../../captions/fonts.js";
import type { CaptionFontSpec } from "../../captions/layout.js";
import type { CaptionScript } from "../../captions/script.js";

export type CaptionFontUrls = Readonly<Record<string, string>> | null;

const pending = new Map<string, Promise<void>>();
const FONT_TIMEOUT_MS = 30_000;

function remember(key: string, load: () => Promise<void>): Promise<void> {
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = load().catch((error: unknown) => {
    pending.delete(key);
    throw error;
  });
  pending.set(key, promise);
  return promise;
}

async function addFace(face: FontFace): Promise<void> {
  document.fonts.add(face);
  await face.load();
}

function bundledUrl(file: string, urls: CaptionFontUrls): string {
  return urls?.[file] ?? staticFile(`fonts/${file}`);
}

function loadBundledFonts(urls: CaptionFontUrls): Promise<void> {
  return Promise.all(BUNDLED_CAPTION_FONTS.map((font) => remember(`bundled:${font.file}`, () => addFace(new FontFace(
    font.family,
    `url(${bundledUrl(font.file, urls)}) format("woff2")`,
    { weight: String(font.weight), unicodeRange: font.unicodeRange, display: "block" },
  ))))).then(() => undefined);
}

function unicodeRange(text: string): string {
  return [...new Set([...text])]
    .map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase()}`)
    .join(", ");
}

function stylesheetFontUrls(css: string): string[] {
  return [...css.matchAll(/src:\s*url\(([^)]+)\)/gu)].map((match) => match[1].replace(/^['"]|['"]$/gu, ""));
}

async function loadTextSubset(family: string, text: string): Promise<void> {
  const chars = [...new Set([...text].filter((char) => char.trim().length > 0))].sort().join("");
  if (!chars) return;
  await remember(`subset:${family}:${chars}`, async () => {
    const response = await fetch(googleTextSubsetUrl(family, chars));
    if (!response.ok) throw new Error(`Caption font ${family} could not be loaded (${response.status}).`);
    const urls = stylesheetFontUrls(await response.text());
    await Promise.all(urls.map((url) => addFace(new FontFace(family, `url(${url})`, {
      weight: String(CAPTION_FALLBACK_WEIGHT),
      unicodeRange: unicodeRange(chars),
      display: "block",
    }))));
  });
}

async function loadCaptionFonts(urls: CaptionFontUrls, scripts: ReadonlySet<CaptionScript>, text: string): Promise<void> {
  await loadBundledFonts(urls);
  await Promise.all(captionScriptFamilies(scripts).map((family) => loadTextSubset(family, text)));
}

export function useCaptionFonts(urls: CaptionFontUrls, scripts: ReadonlySet<CaptionScript>, text: string): boolean {
  const key = `${[...scripts].sort().join(",")}|${text}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const handle = delayRender("Loading subtitle fonts", { timeoutInMilliseconds: FONT_TIMEOUT_MS });
    loadCaptionFonts(urls, scripts, text)
      .then(() => {
        if (active) setLoadedKey(key);
        continueRender(handle);
      })
      .catch((error: unknown) => {
        if (active && getRemotionEnvironment().isRendering) {
          cancelRender(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (active) setLoadedKey(key);
        continueRender(handle);
      });
    return () => {
      active = false;
    };
  }, [key, scripts, text, urls]);
  return loadedKey === key;
}

let canvas: HTMLCanvasElement | null = null;

export function measureCaptionText(text: string, font: CaptionFontSpec, stack: string): number {
  canvas ??= document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return text.length * font.size * 0.55;
  context.font = `${font.weight} ${font.size}px ${stack}`;
  return context.measureText(text).width;
}

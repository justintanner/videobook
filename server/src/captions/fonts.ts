import type { CaptionPreset } from "./model.js";
import type { CaptionScript } from "./script.js";

export interface BundledCaptionFont {
  family: string;
  weight: number;
  file: string;
  unicodeRange: string;
}

export const BUNDLED_CAPTION_FONTS: readonly BundledCaptionFont[] = [
  { family: "Anton", weight: 400, file: "anton-400-vietnamese.woff2", unicodeRange: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  { family: "Anton", weight: 400, file: "anton-400-latin-ext.woff2", unicodeRange: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "Anton", weight: 400, file: "anton-400-latin.woff2", unicodeRange: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { family: "Montserrat", weight: 800, file: "montserrat-800-cyrillic-ext.woff2", unicodeRange: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  { family: "Montserrat", weight: 800, file: "montserrat-800-cyrillic.woff2", unicodeRange: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  { family: "Montserrat", weight: 800, file: "montserrat-800-vietnamese.woff2", unicodeRange: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  { family: "Montserrat", weight: 800, file: "montserrat-800-latin-ext.woff2", unicodeRange: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "Montserrat", weight: 800, file: "montserrat-800-latin.woff2", unicodeRange: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
];

export interface CaptionFontFace {
  family: string;
  weight: number;
}

const PRESET_FONTS: Record<CaptionPreset, CaptionFontFace> = {
  karaoke: { family: "Montserrat", weight: 800 },
  stack: { family: "Anton", weight: 400 },
  punch: { family: "Anton", weight: 400 },
};

const SCRIPT_FAMILIES: Partial<Record<CaptionScript, string>> = {
  cyrillic: "Noto Sans",
  greek: "Noto Sans",
  arabic: "Noto Sans Arabic",
  hebrew: "Noto Sans Hebrew",
  devanagari: "Noto Sans Devanagari",
  thai: "Noto Sans Thai",
  japanese: "Noto Sans JP",
  korean: "Noto Sans KR",
  chinese: "Noto Sans SC",
};

export const CAPTION_FALLBACK_WEIGHT = 800;
const SYSTEM_FALLBACK = "\"Helvetica Neue\", Arial, sans-serif";

export function captionPresetFont(preset: CaptionPreset): CaptionFontFace {
  return PRESET_FONTS[preset];
}

export function captionScriptFamilies(scripts: ReadonlySet<CaptionScript>): string[] {
  return [...scripts].map((script) => SCRIPT_FAMILIES[script]).filter((family): family is string => Boolean(family));
}

export function captionFontStack(preset: CaptionPreset, scripts: ReadonlySet<CaptionScript>): string {
  const primary = PRESET_FONTS[preset].family;
  return [primary, ...captionScriptFamilies(scripts)].map((family) => `"${family}"`).concat(SYSTEM_FALLBACK).join(", ");
}

export function googleTextSubsetUrl(family: string, text: string): string {
  const unique = [...new Set([...text].filter((char) => char.trim().length > 0))].sort().join("");
  const name = family.replace(/ /gu, "+");
  return `https://fonts.googleapis.com/css2?family=${name}:wght@${CAPTION_FALLBACK_WEIGHT}&text=${encodeURIComponent(unique)}&display=block`;
}

export type CaptionScript =
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "devanagari"
  | "thai"
  | "japanese"
  | "korean"
  | "chinese";

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;
const LETTER = /\p{L}/u;

const SCRIPT_PATTERNS: ReadonlyArray<[CaptionScript, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["thai", /\p{Script=Thai}/u],
  ["japanese", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["korean", /\p{Script=Hangul}/u],
];

const HAN = /\p{Script=Han}/u;
const CASED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Georgian}]/u;

export function isUnspacedText(text: string): boolean {
  return UNSPACED.test(text);
}

export function textDirection(text: string): "ltr" | "rtl" {
  for (const char of text) {
    if (RTL.test(char)) return "rtl";
    if (LETTER.test(char)) return "ltr";
  }
  return "ltr";
}

function hanScript(scripts: Set<CaptionScript>, language: string | null): CaptionScript {
  if (scripts.has("japanese") || language?.startsWith("ja")) return "japanese";
  if (scripts.has("korean") || language?.startsWith("ko")) return "korean";
  return "chinese";
}

export function captionScripts(text: string, language: string | null = null): Set<CaptionScript> {
  const scripts = new Set<CaptionScript>();
  for (const [script, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(text)) scripts.add(script);
  }
  if (HAN.test(text)) scripts.add(hanScript(scripts, language));
  return scripts;
}

export function joinCaptionWords(words: readonly string[]): string {
  let text = "";
  for (const word of words) {
    if (!word) continue;
    const previous = text.at(-1) ?? "";
    const glue = text.length > 0 && !(isUnspacedText(previous) && isUnspacedText(word.charAt(0)));
    text += glue ? ` ${word}` : word;
  }
  return text;
}

export function captionCase(text: string, uppercase: boolean, language: string | null): string {
  if (!uppercase || !CASED.test(text)) return text;
  try {
    return language ? text.toLocaleUpperCase(language) : text.toUpperCase();
  } catch {
    return text.toUpperCase();
  }
}

export function captionTextLength(words: readonly string[]): number {
  return [...joinCaptionWords(words)].length;
}

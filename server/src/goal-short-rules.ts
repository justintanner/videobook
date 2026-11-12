export const SHORT_RULES = {
  frame: "Candid phone photo taken in available light in an ordinary real place. Natural colour, unretouched skin, slightly imperfect framing. No text, captions, logos, borders or watermarks.",
  video: "Real phone footage in one continuous take at real-time speed, with slight handheld movement and natural weight and physics. No slow motion, cuts, zooms, effects or on-screen text.",
  silence: "The main character never speaks: no dialogue, voiceover, narration or singing, lips closed. No music. Natural ambient sound only.",
} as const;

export const SHORT_BANNED_WORDS = [
  "cinematic",
  "masterpiece",
  "editorial",
  "epic",
  "stunning",
  "hyperrealistic",
  "hyper-realistic",
  "photorealistic",
  "ultra-detailed",
  "8k",
  "4k",
  "bokeh",
  "anamorphic",
  "Portra",
  "Cinestill",
  "Kodak",
  "film still",
  "studio lighting",
  "dramatic lighting",
  "octane",
  "unreal engine",
] as const;

export type ShortBannedWord = (typeof SHORT_BANNED_WORDS)[number];

export const SHORT_AVOID = [
  "close-ups of hands or fingers",
  "readable signs, screens or labels",
  "crowds of faces",
  "mirrors and reflections",
  "fast or acrobatic movement",
  "anything that needs speech",
] as const;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function wholeWord(word: ShortBannedWord, flags: string, trailing = ""): RegExp {
  const body = word.split(/\s+/u).map(escaped).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])${trailing}`, flags);
}

export function shortBannedWords(text: string): ShortBannedWord[] {
  return SHORT_BANNED_WORDS.filter((word) => wholeWord(word, "iu").test(text));
}

function tidied(text: string): string {
  return text
    .replace(/[^\S\n]+/gu, " ")
    .replace(/([.!?])(?: [.;:,])+/gu, "$1")
    .replace(/ +([,.;:!?])/gu, "$1")
    .replace(/,(?:\s*,)+/gu, ",")
    .replace(/,[^\S\n]*(?=[.;:!?]|$)/gmu, "")
    .replace(/^[ ,;:]+|[ ]+$/gmu, "")
    .trim();
}

export function stripShortBannedWords(text: string): string {
  if (shortBannedWords(text).length === 0) return text;
  return tidied(SHORT_BANNED_WORDS.reduce((current, word) => current.replace(wholeWord(word, "giu", "(?:[^\\S\\n]*,)?"), ""), text));
}

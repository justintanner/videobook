export const LEGACY_SHORT_SILENCE = "The main character never speaks: no dialogue, voiceover, narration or singing, lips closed. No music. Natural ambient sound only.";

export const SHORT_RULES = {
  frame: "Candid phone photo taken in available light in an ordinary real place. Natural colour, unretouched skin, slightly imperfect framing. No text, captions, logos, borders or watermarks.",
  video: "Real phone footage filmed by someone off screen, in one continuous take at real-time speed, with slight handheld camera movement and natural weight and physics. No slow motion, cuts, zooms, effects or on-screen text.",
  silence: "The person never speaks: no dialogue, voiceover, narration or singing, lips closed. No music. Natural ambient sound only.",
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

const PHONE = "(?<![\\p{L}\\p{N}])(?:i|smart|cell|tele|pay)?phones?(?![\\p{L}\\p{N}])";
const PHONE_WORD = new RegExp(PHONE, "iu");
const NO_PHONE = new RegExp(`(?:(?<![\\p{L}\\p{N}])(?:no|not|never|nor|without)|n['’]t)(?![\\p{L}\\p{N}])[^.!?;:,\\n]*?${PHONE}`, "iu");

export function shortMentionsPhone(text: string): boolean {
  return PHONE_WORD.test(text);
}

export function shortRulesOutPhone(text: string): boolean {
  return NO_PHONE.test(text);
}

export function shortWantsPhone(text: string): boolean {
  return shortMentionsPhone(text) && !shortRulesOutPhone(text);
}

export function withoutShortPhoneSentences(text: string): string {
  if (!shortMentionsPhone(text)) return text;
  return text.trim().split(/(?<=[.!?])\s+/u).filter((sentence) => !shortMentionsPhone(sentence)).join(" ");
}

import type { CaptionMotion, CaptionStyle } from "./model.js";
import type { CaptionCue, TimedCaptionWord } from "./timing.js";

export interface CaptionWordLook {
  opacity: number;
  scale: number;
  translateY: number;
  highlighted: boolean;
}

const APPEAR_SECONDS = 0.12;
const FADE_SECONDS = 0.15;
const HIGHLIGHT_SECONDS = 0.08;
const HIT_ENERGY = 0.8;

interface MotionCurve {
  seconds: number;
  apply: (eased: number, progress: number, energy: number, fontSize: number) => Omit<CaptionWordLook, "highlighted">;
}

const MOTIONS: Record<CaptionMotion, MotionCurve> = {
  pop: {
    seconds: 0.14,
    apply: (eased, _progress, energy, fontSize) => ({
      opacity: eased,
      scale: 1 + (1 - eased) * 0.3 * (0.6 + energy),
      translateY: (1 - eased) * fontSize * 0.12,
    }),
  },
  slam: {
    seconds: 0.09,
    apply: (eased, progress) => ({ opacity: clamp01(progress * 3), scale: 1 + (1 - eased) * 0.9, translateY: 0 }),
  },
  rise: {
    seconds: 0.22,
    apply: (eased, _progress, _energy, fontSize) => ({ opacity: eased, scale: 1, translateY: (1 - eased) * fontSize * 0.35 }),
  },
};

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function easeOut(progress: number): number {
  return 1 - Math.pow(1 - clamp01(progress), 3);
}

export function cueVisibility(cue: CaptionCue, time: number, fontSize: number): { opacity: number; translateY: number } {
  const appear = easeOut((time - cue.start) / APPEAR_SECONDS);
  const fade = clamp01((cue.end - time) / FADE_SECONDS);
  return { opacity: Math.min(appear, fade), translateY: (1 - appear) * fontSize * 0.12 };
}

function isActive(word: TimedCaptionWord, time: number): boolean {
  return time >= word.start && time < word.end;
}

function karaokeLook(word: TimedCaptionWord, time: number, measured: boolean): CaptionWordLook {
  const active = measured && isActive(word, time);
  return {
    opacity: 1,
    scale: active ? 1 + 0.08 * easeOut((time - word.start) / HIGHLIGHT_SECONDS) : 1,
    translateY: 0,
    highlighted: active,
  };
}

function entranceLook(word: TimedCaptionWord, time: number, style: CaptionStyle, fontSize: number): CaptionWordLook {
  const age = time - word.start;
  const highlighted = isActive(word, time) || (age >= 0 && word.energy >= HIT_ENERGY);
  if (age < 0) return { opacity: 0, scale: 1, translateY: 0, highlighted: false };
  const curve = MOTIONS[style.motion];
  const progress = clamp01(age / curve.seconds);
  const energy = style.energySizing ? word.energy : 0.5;
  return { ...curve.apply(easeOut(progress), progress, energy, fontSize), highlighted };
}

export function captionWordLook(word: TimedCaptionWord, time: number, style: CaptionStyle, fontSize: number, measured: boolean): CaptionWordLook {
  if (style.preset === "karaoke") return karaokeLook(word, time, measured);
  return entranceLook(word, time, style, fontSize);
}

export function punchWord(cue: CaptionCue, time: number): TimedCaptionWord | null {
  let latest: TimedCaptionWord | null = null;
  for (const word of cue.words) {
    if (word.start <= time) latest = word;
    else break;
  }
  return latest;
}

export function energyScale(words: readonly TimedCaptionWord[], style: CaptionStyle): number {
  if (!style.energySizing || style.preset === "karaoke" || words.length === 0) return 1;
  const energy = Math.max(...words.map((word) => word.energy));
  return 0.88 + 0.24 * energy;
}

import type { CaptionRegion } from "./analysis.js";
import type { CaptionAspect, CaptionDocument, CaptionPreset } from "./model.js";
import { CAPTION_ASPECT_SIZES } from "./model.js";
import { captionPresetFont } from "./fonts.js";
import { containRect } from "./geometry.js";
import { captionCase, isUnspacedText, textDirection } from "./script.js";
import type { CaptionCue, TimedCaptionWord } from "./timing.js";
import { captionCues } from "./timing.js";

export interface CaptionFontSpec {
  family: string;
  weight: number;
  size: number;
}

export type CaptionMeasure = (text: string, font: CaptionFontSpec) => number;

export interface CaptionRegionFrame {
  time: number;
  regions: CaptionRegion[];
}

export interface CaptionLayoutWord extends TimedCaptionWord {
  display: string;
  width: number;
}

export interface CaptionLayoutLine {
  words: CaptionLayoutWord[];
  width: number;
}

export type CaptionPlacement = "phrase" | "global" | "auto" | "avoided";

export interface CaptionBlock {
  cue: CaptionCue;
  fontSize: number;
  space: number;
  lineHeight: number;
  gap: number;
  lines: CaptionLayoutLine[];
  x: number;
  y: number;
  width: number;
  height: number;
  centerY: number;
  placement: CaptionPlacement;
  direction: "ltr" | "rtl";
}

export interface CaptionSafeZone {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const CAPTION_SAFE_ZONES: Record<CaptionAspect, CaptionSafeZone> = {
  "9:16": { top: 0.085, bottom: 0.22, left: 0.05, right: 0.125 },
  "4:5": { top: 0.06, bottom: 0.12, left: 0.05, right: 0.08 },
  "1:1": { top: 0.06, bottom: 0.1, left: 0.05, right: 0.05 },
  "16:9": { top: 0.06, bottom: 0.1, left: 0.05, right: 0.05 },
};

export const DEFAULT_CAPTION_POSITIONS: Record<CaptionAspect, number> = {
  "9:16": 0.68,
  "4:5": 0.76,
  "1:1": 0.78,
  "16:9": 0.82,
};

const BASE_FONT_RATIO: Record<CaptionPreset, number> = { karaoke: 0.066, stack: 0.085, punch: 0.15 };
const MAX_LINES: Record<CaptionPreset, number> = { karaoke: 2, stack: 4, punch: 1 };
const LINE_HEIGHT: Record<CaptionPreset, number> = { karaoke: 1.18, stack: 0.98, punch: 1 };
const STACK_WORDS_PER_LINE = 2;
const MIN_FONT_SCALE = 0.6;
const SHRINK_STEP = 0.92;
const EDGE_MARGIN = 0.02;
const REGION_PAD = 0.012;
const REGION_TIME_PAD = 0.25;
const SEARCH_STEP = 0.01;

export interface CaptionLayoutInput {
  document: CaptionDocument;
  regions: readonly CaptionRegionFrame[];
  measure: CaptionMeasure;
  aspect?: CaptionAspect;
}

export function captionTextWidthLimit(aspect: CaptionAspect): number {
  const frame = CAPTION_ASPECT_SIZES[aspect];
  const zone = CAPTION_SAFE_ZONES[aspect];
  return 2 * Math.min(0.5 - zone.left, 1 - zone.right - 0.5) * frame.width;
}

export function baseCaptionFontSize(document: CaptionDocument, aspect: CaptionAspect): number {
  const frame = CAPTION_ASPECT_SIZES[aspect];
  return Math.round(Math.min(frame.width, frame.height) * BASE_FONT_RATIO[document.style.preset] * document.style.fontScale);
}

function captionLanguage(document: CaptionDocument): string | null {
  return document.language === "original" ? document.sourceLanguage : document.language;
}

function measured(words: readonly TimedCaptionWord[], document: CaptionDocument, font: CaptionFontSpec, measure: CaptionMeasure): CaptionLayoutWord[] {
  const language = captionLanguage(document);
  return words.map((word) => {
    const display = captionCase(word.text, document.style.uppercase, language);
    return { ...word, display, width: measure(display, font) };
  });
}

function joinsTight(left: CaptionLayoutWord, right: CaptionLayoutWord): boolean {
  return isUnspacedText(left.display.at(-1) ?? "") && isUnspacedText(right.display.charAt(0));
}

function lineWidth(words: readonly CaptionLayoutWord[], space: number): number {
  return words.reduce((sum, word, index) => sum + word.width + (index > 0 && !joinsTight(words[index - 1], word) ? space : 0), 0);
}

function greedyLines(words: readonly CaptionLayoutWord[], space: number, limit: number, perLine: number): CaptionLayoutLine[] {
  const lines: CaptionLayoutWord[][] = [];
  let current: CaptionLayoutWord[] = [];
  for (const word of words) {
    const candidate = [...current, word];
    if (current.length > 0 && (lineWidth(candidate, space) > limit || current.length >= perLine)) {
      lines.push(current);
      current = [word];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((line) => ({ words: line, width: lineWidth(line, space) }));
}

interface FittedLines {
  fontSize: number;
  space: number;
  lines: CaptionLayoutLine[];
}

const PUNCH_MIN_SCALE = 0.4;

function fitPunch(cueWords: readonly TimedCaptionWord[], document: CaptionDocument, aspect: CaptionAspect, measure: CaptionMeasure): FittedLines {
  const face = captionPresetFont("punch");
  const limit = captionTextWidthLimit(aspect);
  const base = baseCaptionFontSize(document, aspect);
  const probe = measured(cueWords, document, { family: face.family, weight: face.weight, size: base }, measure);
  const widest = Math.max(1, ...probe.map((word) => word.width));
  const size = Math.max(Math.floor(base * PUNCH_MIN_SCALE), Math.min(base, Math.floor(base * limit / widest)));
  const font = { family: face.family, weight: face.weight, size };
  const words = measured(cueWords, document, font, measure);
  return { fontSize: size, space: measure(" ", font), lines: words.map((word) => ({ words: [word], width: word.width })) };
}

function fitLines(cueWords: readonly TimedCaptionWord[], document: CaptionDocument, aspect: CaptionAspect, measure: CaptionMeasure): FittedLines {
  const preset = document.style.preset;
  if (preset === "punch") return fitPunch(cueWords, document, aspect, measure);
  const face = captionPresetFont(preset);
  const limit = captionTextWidthLimit(aspect);
  const base = baseCaptionFontSize(document, aspect);
  const perLine = preset === "stack" ? STACK_WORDS_PER_LINE : Number.POSITIVE_INFINITY;
  let best: FittedLines | null = null;
  for (const size of shrinkingSizes(base)) {
    const font = { family: face.family, weight: face.weight, size };
    const words = measured(cueWords, document, font, measure);
    const space = measure(" ", font);
    const lines = greedyLines(words, space, limit, perLine);
    best = { fontSize: size, space, lines };
    if (lines.length <= MAX_LINES[preset] && lines.every((line) => line.width <= limit)) return best;
  }
  return best ?? { fontSize: base, space: 0, lines: [] };
}

function shrinkingSizes(base: number): number[] {
  const minimum = Math.ceil(base * MIN_FONT_SCALE);
  const sizes: number[] = [];
  for (let size = base; size > minimum; size = Math.floor(size * SHRINK_STEP)) sizes.push(size);
  return [...sizes, minimum];
}

function phraseRegions(cue: CaptionCue, frames: readonly CaptionRegionFrame[]): CaptionRegion[] {
  const within = frames.filter((frame) => frame.time >= cue.start - REGION_TIME_PAD && frame.time <= cue.end + REGION_TIME_PAD);
  if (within.length > 0) return within.flatMap((frame) => frame.regions);
  const middle = (cue.start + cue.end) / 2;
  const nearest = frames.reduce<CaptionRegionFrame | null>((best, frame) => (
    !best || Math.abs(frame.time - middle) < Math.abs(best.time - middle) ? frame : best
  ), null);
  return nearest && Math.abs(nearest.time - middle) <= 2 ? nearest.regions : [];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function avoidedBoxes(document: CaptionDocument, regions: readonly CaptionRegion[], aspect: CaptionAspect): Box[] {
  const frame = CAPTION_ASPECT_SIZES[aspect];
  const content = containRect({ width: document.source.width, height: document.source.height }, frame);
  const pad = REGION_PAD * frame.height;
  return regions
    .filter((region) => (region.kind === "face" ? document.style.avoidFaces : document.style.avoidText))
    .map((region) => ({
      x: content.x + region.x * content.width - pad,
      y: content.y + region.y * content.height - pad,
      width: region.width * content.width + 2 * pad,
      height: region.height * content.height + 2 * pad,
    }));
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function clampCenter(centerY: number, height: number, frameHeight: number): number {
  const margin = EDGE_MARGIN * frameHeight;
  const min = (margin + height / 2) / frameHeight;
  const max = (frameHeight - margin - height / 2) / frameHeight;
  return min > max ? 0.5 : Math.min(max, Math.max(min, centerY));
}

function blockAt(centerY: number, width: number, height: number, frame: { width: number; height: number }): Box {
  return { x: (frame.width - width) / 2, y: centerY * frame.height - height / 2, width, height };
}

function avoidingCenter(preferred: number, width: number, height: number, boxes: readonly Box[], aspect: CaptionAspect): { centerY: number; moved: boolean } {
  const frame = CAPTION_ASPECT_SIZES[aspect];
  const clear = (center: number) => !boxes.some((box) => overlaps(blockAt(center, width, height, frame), box));
  const start = clampCenter(preferred, height, frame.height);
  if (boxes.length === 0 || clear(start)) return { centerY: start, moved: false };
  const zone = CAPTION_SAFE_ZONES[aspect];
  const top = clampCenter(zone.top + height / frame.height / 2, height, frame.height);
  const bottom = clampCenter(1 - zone.bottom - height / frame.height / 2, height, frame.height);
  const steps = Math.ceil(Math.max(Math.abs(start - top), Math.abs(bottom - start)) / SEARCH_STEP);
  for (let step = 1; step <= steps; step += 1) {
    for (const candidate of [start + step * SEARCH_STEP, start - step * SEARCH_STEP]) {
      if (candidate < top - 1e-9 || candidate > bottom + 1e-9) continue;
      if (clear(candidate)) return { centerY: candidate, moved: true };
    }
  }
  return { centerY: start, moved: false };
}

function placement(document: CaptionDocument, cue: CaptionCue, aspect: CaptionAspect): { centerY: number; source: CaptionPlacement } {
  const phrase = document.phrases.find((candidate) => candidate.id === cue.phraseId);
  const override = phrase?.positions[aspect];
  if (override !== undefined) return { centerY: override, source: "phrase" };
  const global = document.positions[aspect];
  if (global !== undefined) return { centerY: global, source: "global" };
  return { centerY: DEFAULT_CAPTION_POSITIONS[aspect], source: "auto" };
}

function layoutCue(cue: CaptionCue, input: CaptionLayoutInput, aspect: CaptionAspect): CaptionBlock {
  const { document, measure } = input;
  const fitted = fitLines(cue.words, document, aspect, measure);
  const lineHeight = fitted.fontSize * LINE_HEIGHT[document.style.preset];
  const gap = document.style.preset === "stack" ? fitted.fontSize * 0.06 : 0;
  const width = Math.max(1, ...fitted.lines.map((line) => line.width));
  const visibleLines = document.style.preset === "punch" ? Math.min(1, fitted.lines.length) : fitted.lines.length;
  const height = visibleLines * lineHeight + Math.max(0, visibleLines - 1) * gap;
  const frame = CAPTION_ASPECT_SIZES[aspect];
  const preferred = placement(document, cue, aspect);
  const automatic = preferred.source === "auto"
    ? avoidingCenter(preferred.centerY, width, height, avoidedBoxes(document, phraseRegions(cue, input.regions), aspect), aspect)
    : { centerY: clampCenter(preferred.centerY, height, frame.height), moved: false };
  const box = blockAt(automatic.centerY, width, height, frame);
  return {
    cue,
    fontSize: fitted.fontSize,
    space: fitted.space,
    lineHeight,
    gap,
    lines: fitted.lines,
    ...box,
    centerY: automatic.centerY,
    placement: automatic.moved ? "avoided" : preferred.source,
    direction: textDirection(cue.words.map((word) => word.text).join(" ")),
  };
}

export function layoutCaptions(input: CaptionLayoutInput): CaptionBlock[] {
  const aspect = input.aspect ?? input.document.aspect;
  return captionCues(input.document).map((cue) => layoutCue(cue, input, aspect));
}

export function activeCaptionBlock(blocks: readonly CaptionBlock[], time: number): CaptionBlock | null {
  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const block = blocks[middle];
    if (time < block.cue.start) high = middle - 1;
    else if (time >= block.cue.end) low = middle + 1;
    else return block;
  }
  return null;
}

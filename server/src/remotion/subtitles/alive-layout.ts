import type {
  AliveColumn,
  AliveCue,
  AliveCueLine,
  AliveMotion,
  AlivePhrase,
  AliveRegion,
  AliveSettings,
  AliveTimedWord,
  AliveWord,
  FrameGeometry,
  NormalizedBox,
} from "./alive-types.js";

/**
 * Pure layout for alive captions: phrase/line grouping, frame-aware column
 * placement, stack fitting and per-frame word entrance. Shared by the
 * Remotion renderer and the client studio so the preview matches the render.
 */

const PHRASE_GAP_SECONDS = 0.45;
const PHRASE_MAX_WORDS = 8;
const PHRASE_MAX_SECONDS = 3.4;
const PHRASE_MAX_LINES = 4;
const LINE_MAX_WORDS = 2;
const LINE_MAX_CHARS = 11;
const HERO_ENERGY = 0.8;
const HERO_MIN_CHARS = 5;

/** Average advance of the condensed display face per character, in em. */
export const ALIVE_GLYPH_EM = 0.5;
export const ALIVE_LINE_HEIGHT = 0.92;
const LINE_GAP_EM = 0.06;
const LEAD_SECONDS = 0.06;
const HOLD_SECONDS = 0.5;
const FADE_SECONDS = 0.18;
const MIN_WORD_SECONDS = 0.05;
const REGION_PAD = 0.02;
const MIN_FREE_SPAN = 0.3;

const SENTENCE_END = /[.!?]["')\]]*$/;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+$/gu;

export interface PhraseWordInput {
  raw: string;
  start: number;
  end: number;
  onsetStart: number;
  energy: number;
}

export function displayWord(raw: string): string {
  return raw.trim().replace(EDGE_PUNCTUATION, "");
}

function breaksBefore(current: PhraseWordInput[], word: PhraseWordInput): boolean {
  if (current.length === 0) return false;
  const previous = current[current.length - 1];
  return word.start - previous.end >= PHRASE_GAP_SECONDS
    || current.length >= PHRASE_MAX_WORDS
    || word.end - current[0].start > PHRASE_MAX_SECONDS;
}

/** Group one transcript segment's words into sung/spoken phrases. */
export function splitPhrases(words: PhraseWordInput[]): PhraseWordInput[][] {
  const phrases: PhraseWordInput[][] = [];
  let current: PhraseWordInput[] = [];
  for (const word of words) {
    if (breaksBefore(current, word)) {
      phrases.push(current);
      current = [];
    }
    current.push(word);
    if (SENTENCE_END.test(word.raw.trim())) {
      phrases.push(current);
      current = [];
    }
  }
  if (current.length > 0) phrases.push(current);
  return phrases;
}

function isHero(word: AliveWord): boolean {
  return word.energy >= HERO_ENERGY && word.text.length >= HERO_MIN_CHARS;
}

function lineChars(line: AliveWord[]): number {
  return line.reduce((sum, word) => sum + word.text.length, 0) + Math.max(0, line.length - 1);
}

function startsNewLine(line: AliveWord[], word: AliveWord): boolean {
  if (line.length === 0) return false;
  return line.length >= LINE_MAX_WORDS
    || lineChars(line) + 1 + word.text.length > LINE_MAX_CHARS
    || isHero(word)
    || line.some(isHero);
}

/** Stack a phrase into short lines; loud long words get a line of their own. */
export function splitLines(words: AliveWord[]): AliveWord[][] {
  const lines: AliveWord[][] = [];
  let line: AliveWord[] = [];
  for (const word of words) {
    if (startsNewLine(line, word)) {
      lines.push(line);
      line = [];
    }
    line.push(word);
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function toAliveWord(word: PhraseWordInput): AliveWord {
  return {
    text: displayWord(word.raw),
    transcriptStart: word.start,
    transcriptEnd: word.end,
    onsetStart: word.onsetStart,
    energy: word.energy,
  };
}

function chunkLines(lines: AliveWord[][]): AliveWord[][][] {
  const groups: AliveWord[][][] = [];
  for (let index = 0; index < lines.length; index += PHRASE_MAX_LINES) {
    groups.push(lines.slice(index, index + PHRASE_MAX_LINES));
  }
  return groups;
}

/** Phrase line stacks for a list of transcript segments, in time order. */
export function buildPhraseLines(segments: PhraseWordInput[][]): AliveWord[][][] {
  return segments
    .flatMap(splitPhrases)
    .map((phrase) => phrase.map(toAliveWord).filter((word) => word.text.length > 0))
    .filter((phrase) => phrase.length > 0)
    .flatMap((phrase) => chunkLines(splitLines(phrase)));
}

export function phraseFrameTime(lines: AliveWord[][]): number {
  const words = lines.flat();
  const first = words[0];
  const last = words[words.length - 1];
  return (first.transcriptStart + last.transcriptEnd) / 2;
}

export function wordTiming(word: AliveWord, snapToOnsets: boolean): AliveTimedWord {
  const shift = snapToOnsets ? word.onsetStart - word.transcriptStart : 0;
  const start = word.transcriptStart + shift;
  const end = Math.max(start + MIN_WORD_SECONDS, word.transcriptEnd + shift);
  return { text: word.text, start, end, energy: word.energy };
}

/** Pixel rect of the contain-fitted source inside the target frame. */
export function contentRect(geometry: FrameGeometry): { x: number; y: number; width: number; height: number } {
  const { sourceWidth, sourceHeight, targetWidth, targetHeight } = geometry;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

/** Map a source-normalized box into target-normalized coordinates. */
export function regionToTarget(region: NormalizedBox, geometry: FrameGeometry): NormalizedBox {
  const content = contentRect(geometry);
  return {
    x: (content.x + region.x * content.width) / geometry.targetWidth,
    y: (content.y + region.y * content.height) / geometry.targetHeight,
    width: region.width * content.width / geometry.targetWidth,
    height: region.height * content.height / geometry.targetHeight,
  };
}

interface ColumnCandidate {
  side: AliveColumn["side"];
  x0: number;
  x1: number;
}

interface Span {
  y0: number;
  y1: number;
}

function columnCandidates(geometry: FrameGeometry): ColumnCandidate[] {
  if (geometry.targetHeight > geometry.targetWidth) return [{ side: "center", x0: 0.07, x1: 0.93 }];
  return [
    { side: "left", x0: 0.06, x1: 0.47 },
    { side: "right", x0: 0.53, x1: 0.94 },
  ];
}

function verticalBounds(geometry: FrameGeometry): Span {
  const portrait = geometry.targetHeight > geometry.targetWidth;
  return { y0: 0.08, y1: portrait ? 0.86 : 0.92 };
}

function blockersFor(candidate: ColumnCandidate, boxes: NormalizedBox[]): Span[] {
  return boxes
    .filter((box) => box.x - REGION_PAD < candidate.x1 && box.x + box.width + REGION_PAD > candidate.x0)
    .map((box) => ({ y0: box.y - REGION_PAD, y1: box.y + box.height + REGION_PAD }))
    .sort((a, b) => a.y0 - b.y0);
}

/** Free vertical spans of `bounds` once the blocker spans are removed. */
export function freeSpans(bounds: Span, blockers: Span[]): Span[] {
  const spans: Span[] = [];
  let cursor = bounds.y0;
  for (const blocker of blockers) {
    if (blocker.y0 > cursor) spans.push({ y0: cursor, y1: Math.min(blocker.y0, bounds.y1) });
    cursor = Math.max(cursor, blocker.y1);
    if (cursor >= bounds.y1) break;
  }
  if (cursor < bounds.y1) spans.push({ y0: cursor, y1: bounds.y1 });
  return spans.filter((span) => span.y1 - span.y0 > 0);
}

function longestSpan(spans: Span[]): Span | null {
  return spans.reduce<Span | null>(
    (best, span) => best === null || span.y1 - span.y0 > best.y1 - best.y0 ? span : best,
    null,
  );
}

function blockedHeight(blockers: Span[]): number {
  return blockers.reduce((sum, span) => sum + (span.y1 - span.y0), 0);
}

interface ScoredCandidate {
  candidate: ColumnCandidate;
  span: Span | null;
  blocked: number;
}

function scoreCandidate(candidate: ColumnCandidate, bounds: Span, boxes: NormalizedBox[]): ScoredCandidate {
  const blockers = blockersFor(candidate, boxes);
  return { candidate, span: longestSpan(freeSpans(bounds, blockers)), blocked: blockedHeight(blockers) };
}

function spanLength(scored: ScoredCandidate): number {
  return scored.span ? scored.span.y1 - scored.span.y0 : 0;
}

function toColumn(candidate: ColumnCandidate, span: Span, geometry: FrameGeometry): AliveColumn {
  return {
    side: candidate.side,
    x: candidate.x0 * geometry.targetWidth,
    y: span.y0 * geometry.targetHeight,
    width: (candidate.x1 - candidate.x0) * geometry.targetWidth,
    height: (span.y1 - span.y0) * geometry.targetHeight,
  };
}

/**
 * Pick the stack column: the candidate side with the tallest stretch clear of
 * avoided regions (target-normalized). Falls back to the least-covered
 * full-height column when nothing leaves a usable free span.
 */
export function placeColumn(avoid: NormalizedBox[], geometry: FrameGeometry): AliveColumn {
  const bounds = verticalBounds(geometry);
  const scored = columnCandidates(geometry).map((candidate) => scoreCandidate(candidate, bounds, avoid));
  const best = scored.reduce((a, b) => (spanLength(b) > spanLength(a) + 0.02 ? b : a));
  if (best.span && spanLength(best) >= MIN_FREE_SPAN) return toColumn(best.candidate, best.span, geometry);
  const leastBlocked = scored.reduce((a, b) => (b.blocked < a.blocked ? b : a));
  return toColumn(leastBlocked.candidate, bounds, geometry);
}

export function avoidedRegions(regions: AliveRegion[], settings: AliveSettings): AliveRegion[] {
  return regions.filter((region) => (region.kind === "face" ? settings.avoidFaces : settings.avoidText));
}

function lineText(words: AliveTimedWord[]): string {
  return words.map((word) => word.text).join(" ");
}

function lineEnergy(words: AliveTimedWord[]): number {
  return Math.max(...words.map((word) => word.energy));
}

function fitToWidth(text: string, width: number, cap: number): number {
  return Math.min(cap, width / (Math.max(text.length, 2) * ALIVE_GLYPH_EM));
}

export function stackHeight(fontSizes: number[]): number {
  const total = fontSizes.reduce((sum, size) => sum + size * (ALIVE_LINE_HEIGHT + LINE_GAP_EM), 0);
  return total - (fontSizes.length > 0 ? fontSizes[fontSizes.length - 1] * LINE_GAP_EM : 0);
}

export function lineGap(fontSize: number): number {
  return fontSize * LINE_GAP_EM;
}

/** Fit each stacked line to the column width, then shrink the block to fit its height. */
export function fitStack(lines: AliveTimedWord[][], column: AliveColumn, energySizing: boolean): AliveCueLine[] {
  const cap = column.height * 0.36;
  const fitted = lines.map((words) => fitToWidth(lineText(words), column.width, cap));
  const sized = energySizing
    ? fitted.map((size, index) => size * (0.7 + 0.3 * lineEnergy(lines[index])))
    : fitted.map(() => Math.min(...fitted));
  const scale = Math.min(1, column.height / stackHeight(sized));
  return lines.map((words, index) => ({ words, fontSize: Math.round(sized[index] * scale * 10) / 10 }));
}

export function fitPunch(word: AliveTimedWord, column: AliveColumn, energySizing: boolean): number {
  const scale = energySizing ? 0.7 + 0.3 * word.energy : 0.85;
  return Math.min(fitToWidth(word.text, column.width, column.height * 0.6), column.height * 0.6) * scale;
}

function cueWindow(lines: AliveTimedWord[][], nextStart: number | null): { start: number; end: number } {
  const words = lines.flat();
  const start = words[0].start - LEAD_SECONDS;
  const hold = words[words.length - 1].end + HOLD_SECONDS;
  const end = nextStart === null ? hold : Math.min(hold, nextStart - LEAD_SECONDS);
  return { start, end: Math.max(end, start + 0.1) };
}

function firstStart(phrase: AlivePhrase, snap: boolean): number {
  return wordTiming(phrase.lines[0][0], snap).start;
}

/** Resolve analysed phrases into positioned, timed cues for one target frame. */
export function resolveAliveCues(
  phrases: AlivePhrase[],
  settings: AliveSettings,
  geometry: FrameGeometry,
): AliveCue[] {
  return phrases.map((phrase, index) => {
    const lines = phrase.lines.map((line) => line.map((word) => wordTiming(word, settings.snapToOnsets)));
    const next = phrases[index + 1];
    const window = cueWindow(lines, next ? firstStart(next, settings.snapToOnsets) : null);
    const avoid = avoidedRegions(phrase.regions, settings).map((region) => regionToTarget(region, geometry));
    const column = placeColumn(avoid, geometry);
    const fitted = fitStack(lines, column, settings.energySizing);
    const blockHeight = stackHeight(fitted.map((line) => line.fontSize));
    return {
      id: phrase.id,
      start: window.start,
      end: window.end,
      column,
      lines: fitted,
      blockTop: column.y + (column.height - blockHeight) / 2,
    };
  });
}

export function activeCue(cues: AliveCue[], time: number): AliveCue | null {
  return cues.find((cue) => time >= cue.start && time < cue.end) ?? null;
}

export function cueFade(cue: AliveCue, time: number): number {
  return clamp01((cue.end - time) / FADE_SECONDS);
}

/** The most recently started word of a cue, for punch style. */
export function punchWord(cue: AliveCue, time: number): AliveTimedWord | null {
  return cue.lines.flatMap((line) => line.words).filter((word) => word.start <= time).pop() ?? null;
}

export interface AliveWordLook {
  opacity: number;
  scale: number;
  translateY: number;
  color: string;
}

interface MotionCurve {
  seconds: number;
  apply: (eased: number, progress: number, energy: number, fontSize: number) => Omit<AliveWordLook, "color">;
}

const MOTIONS: Record<AliveMotion, MotionCurve> = {
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

function wordColor(word: AliveTimedWord, time: number, settings: AliveSettings): string {
  const started = time >= word.start;
  const active = started && time < word.end;
  return active || (started && word.energy >= HERO_ENERGY) ? settings.hitColor : settings.textColor;
}

export function wordLook(
  word: AliveTimedWord,
  time: number,
  settings: AliveSettings,
  fontSize: number,
  fade: number,
): AliveWordLook {
  const age = time - word.start;
  const color = wordColor(word, time, settings);
  if (settings.style === "karaoke") {
    return { opacity: (age < 0 ? 0.3 : 1) * fade, scale: 1, translateY: 0, color };
  }
  if (age < 0) return { opacity: 0, scale: 1, translateY: 0, color };
  const curve = MOTIONS[settings.motion];
  const progress = clamp01(age / curve.seconds);
  const eased = 1 - Math.pow(1 - progress, 3);
  const energy = settings.energySizing ? word.energy : 0.5;
  const look = curve.apply(eased, progress, energy, fontSize);
  return { ...look, opacity: look.opacity * fade, color };
}

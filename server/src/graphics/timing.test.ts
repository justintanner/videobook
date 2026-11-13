import { describe, expect, it } from "vitest";
import type { GraphicsTiming } from "./model.js";
import { groupMotionAt, layerOpacityAt, resolveLayerTiming } from "./timing.js";

const CLIPS = [3, 8, 30];

function timing(fields: Partial<GraphicsTiming>): GraphicsTiming {
  return { start: null, end: null, tail: null, enter: "fade", exit: "fade", fade: 0.5, ...fields };
}

function burnFades(startSeconds: number | undefined, endSeconds: number | undefined, duration: number, fadeSeconds: number): { fadeIn: number; fadeOut: number } {
  const start = Math.max(0, startSeconds ?? 0);
  const window = (endSeconds === undefined ? duration : Math.min(endSeconds, duration)) - start;
  if (!(fadeSeconds > 0) || !(window > 0)) return { fadeIn: 0, fadeOut: 0 };
  const fade = Math.round(Math.min(fadeSeconds, window / 2) * 1000) / 1000;
  const endsEarly = endSeconds !== undefined && endSeconds < duration - 0.001;
  return { fadeIn: start > 0 ? fade : 0, fadeOut: endsEarly ? fade : 0 };
}

function burnWindow(value: GraphicsTiming, duration: number): { start?: number; end?: number } {
  if (value.start !== null || value.end !== null) return { start: value.start ?? undefined, end: value.end ?? undefined };
  if (value.tail !== null) return { start: Math.max(0, duration - value.tail), end: duration };
  return {};
}

const WINDOWS: Array<[string, GraphicsTiming]> = [
  ["the whole clip", timing({})],
  ["a late start", timing({ start: 1 })],
  ["an early end", timing({ end: 2 })],
  ["a middle window", timing({ start: 0.5, end: 2.5, fade: 0.3 })],
  ["a short window with a long fade", timing({ start: 1, end: 1.6, fade: 2 })],
  ["the last two seconds", timing({ tail: 2, fade: 0.3 })],
  ["a tail longer than the clip", timing({ tail: 40 })],
  ["an end past the clip", timing({ start: 1, end: 45 })],
  ["an end within a millisecond of the clip end", timing({ start: 1, end: 2.9995 })],
  ["no fade", timing({ start: 1, end: 2, fade: 0 })],
  ["a fade that rounds to milliseconds", timing({ start: 0.2, end: 0.4571, fade: 2 })],
];

describe("resolveLayerTiming", () => {
  it.each(WINDOWS)("matches today's watermark fades for %s in clips of 3, 8 and 30 seconds", (_name, value) => {
    for (const duration of CLIPS) {
      const resolved = resolveLayerTiming(value, duration);
      const burn = burnWindow(value, duration);
      const fades = burnFades(burn.start, burn.end, duration, value.fade);
      expect(resolved).not.toBeNull();
      expect({ fadeIn: resolved?.fadeIn, fadeOut: resolved?.fadeOut }).toEqual(fades);
      expect(resolved?.start).toBe(Math.min(burn.start ?? 0, duration));
      expect(resolved?.end).toBe(Math.min(burn.end ?? duration, duration));
    }
  });

  it("resolves explicit, tail and whole-clip windows the way resolveOsgWindow does", () => {
    expect(resolveLayerTiming(timing({ start: 2, tail: 1 }), 8)).toEqual({ start: 2, end: 8, fadeIn: 0.5, fadeOut: 0, enter: "fade", exit: "fade" });
    expect(resolveLayerTiming(timing({ end: 3, tail: 1 }), 8)).toEqual({ start: 0, end: 3, fadeIn: 0, fadeOut: 0.5, enter: "fade", exit: "fade" });
    expect(resolveLayerTiming(timing({ tail: 3 }), 8)).toEqual({ start: 5, end: 8, fadeIn: 0.5, fadeOut: 0, enter: "fade", exit: "fade" });
    expect(resolveLayerTiming(timing({}), 8)).toEqual({ start: 0, end: 8, fadeIn: 0, fadeOut: 0, enter: "fade", exit: "fade" });
  });

  it("returns null for an empty window", () => {
    expect(resolveLayerTiming(timing({ start: 3 }), 3)).toBeNull();
    expect(resolveLayerTiming(timing({ start: 9, end: 12 }), 8)).toBeNull();
    expect(resolveLayerTiming(timing({ start: 2, end: 2 }), 8)).toBeNull();
    expect(resolveLayerTiming(timing({ start: 4, end: 1 }), 8)).toBeNull();
    expect(resolveLayerTiming(timing({ end: 0 }), 8)).toBeNull();
    expect(resolveLayerTiming(timing({ tail: 0 }), 8)).toBeNull();
    expect(resolveLayerTiming(timing({}), 0)).toBeNull();
    expect(resolveLayerTiming(timing({}), Number.NaN)).toBeNull();
  });
});

describe("layerOpacityAt", () => {
  const faded = resolveLayerTiming(timing({ start: 2, end: 6, fade: 1 }), 8);

  it("is 0 outside the window and 1 in the middle", () => {
    expect(faded).toEqual({ start: 2, end: 6, fadeIn: 1, fadeOut: 1, enter: "fade", exit: "fade" });
    for (const seconds of [0, 1.999, 6.001, 8, -1, Number.NaN]) expect(layerOpacityAt(faded, seconds)).toBe(0);
    for (const seconds of [3, 4, 5]) expect(layerOpacityAt(faded, seconds)).toBe(1);
    expect(layerOpacityAt(null, 4)).toBe(0);
  });

  it("ramps linearly inside each fade", () => {
    expect(layerOpacityAt(faded, 2)).toBe(0);
    expect(layerOpacityAt(faded, 2.25)).toBeCloseTo(0.25, 10);
    expect(layerOpacityAt(faded, 2.5)).toBeCloseTo(0.5, 10);
    expect(layerOpacityAt(faded, 5.75)).toBeCloseTo(0.25, 10);
    expect(layerOpacityAt(faded, 6)).toBe(0);
  });

  it("keeps hard edges where a window has no fade", () => {
    const whole = resolveLayerTiming(timing({}), 8);
    expect(layerOpacityAt(whole, 0)).toBe(1);
    expect(layerOpacityAt(whole, 8)).toBe(1);
    const tail = resolveLayerTiming(timing({ tail: 3, fade: 0.4 }), 8);
    expect(layerOpacityAt(tail, 5.2)).toBeCloseTo(0.5, 10);
    expect(layerOpacityAt(tail, 8)).toBe(1);
  });

  it("reaches full opacity at the midpoint of a window shorter than its two fades", () => {
    const short = resolveLayerTiming(timing({ start: 1, end: 1.6, fade: 2 }), 8);
    expect(short).toEqual({ start: 1, end: 1.6, fadeIn: 0.3, fadeOut: 0.3, enter: "fade", exit: "fade" });
    expect(layerOpacityAt(short, 1.3)).toBeCloseTo(1, 10);
    expect(layerOpacityAt(short, 1.15)).toBeCloseTo(0.5, 10);
  });
});

describe("groupMotionAt", () => {
  const box = { x: 20, y: 100, width: 80, height: 40, frameWidth: 360, frameHeight: 640 };

  it("keeps fade opacity identical to the existing linear ramp", () => {
    const window = resolveLayerTiming(timing({ start: 1, end: 5, fade: 1 }), 8);
    for (const seconds of [0, 1, 1.25, 1.5, 2, 4, 4.25, 4.5, 5, 6]) {
      expect(groupMotionAt(window, seconds, box).opacity).toBe(layerOpacityAt(window, seconds));
    }
  });

  it("slides from and to the nearest edge with cubic ease out", () => {
    const window = resolveLayerTiming(timing({ start: 1, end: 5, fade: 1, enter: "slide", exit: "slide" }), 8);
    expect(groupMotionAt(window, 1, box)).toMatchObject({ dx: -100, dy: 0, scale: 1 });
    expect(groupMotionAt(window, 1.5, box).dx).toBe(-12.5);
    expect(groupMotionAt(window, 2, box).dx).toBe(0);
    expect(groupMotionAt(window, 4.5, box).dx).toBe(-87.5);
    expect(groupMotionAt(window, 5, box).dx).toBe(-100);
    expect(groupMotionAt(window, 5.01, box).opacity).toBe(0);
  });

  it("pops from 85 percent and reveals words without moving their layout", () => {
    const pop = resolveLayerTiming(timing({ start: 1, end: 5, fade: 1, enter: "pop", exit: "pop" }), 8);
    expect(groupMotionAt(pop, 1, box)).toMatchObject({ scale: 0.85, opacity: 0 });
    expect(groupMotionAt(pop, 1.5, box)).toMatchObject({ scale: 0.98125, opacity: 0.875 });
    expect(groupMotionAt(pop, 2, box)).toMatchObject({ scale: 1, opacity: 1 });
    expect(groupMotionAt(pop, 5, box)).toMatchObject({ scale: 0.85, opacity: 0 });
    const words = resolveLayerTiming(timing({ start: 1, end: 5, fade: 1, enter: "words", exit: "words" }), 8);
    expect(groupMotionAt(words, 1, box).reveal).toBe(0);
    expect(groupMotionAt(words, 1.5, box).reveal).toBe(0.875);
    expect(groupMotionAt(words, 2, box).reveal).toBe(1);
    expect(groupMotionAt(words, 5, box).reveal).toBe(0);
  });
});

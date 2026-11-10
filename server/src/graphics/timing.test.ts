import { describe, expect, it } from "vitest";
import { burnWatermarkFades } from "../jobs/burn-watermark.js";
import type { GraphicsTiming } from "./model.js";
import { layerOpacityAt, resolveLayerTiming } from "./timing.js";

const CLIPS = [3, 8, 30];

function timing(fields: Partial<GraphicsTiming>): GraphicsTiming {
  return { start: null, end: null, tail: null, fade: 0.5, ...fields };
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
  it.each(WINDOWS)("matches burnWatermarkFades for %s in clips of 3, 8 and 30 seconds", (_name, value) => {
    for (const duration of CLIPS) {
      const resolved = resolveLayerTiming(value, duration);
      const burn = burnWindow(value, duration);
      const fades = burnWatermarkFades(burn.start, burn.end, duration, value.fade);
      expect(resolved).not.toBeNull();
      expect({ fadeIn: resolved?.fadeIn, fadeOut: resolved?.fadeOut }).toEqual(fades);
      expect(resolved?.start).toBe(Math.min(burn.start ?? 0, duration));
      expect(resolved?.end).toBe(Math.min(burn.end ?? duration, duration));
    }
  });

  it("resolves explicit, tail and whole-clip windows the way resolveOsgWindow does", () => {
    expect(resolveLayerTiming(timing({ start: 2, tail: 1 }), 8)).toEqual({ start: 2, end: 8, fadeIn: 0.5, fadeOut: 0 });
    expect(resolveLayerTiming(timing({ end: 3, tail: 1 }), 8)).toEqual({ start: 0, end: 3, fadeIn: 0, fadeOut: 0.5 });
    expect(resolveLayerTiming(timing({ tail: 3 }), 8)).toEqual({ start: 5, end: 8, fadeIn: 0.5, fadeOut: 0 });
    expect(resolveLayerTiming(timing({}), 8)).toEqual({ start: 0, end: 8, fadeIn: 0, fadeOut: 0 });
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
    expect(faded).toEqual({ start: 2, end: 6, fadeIn: 1, fadeOut: 1 });
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
    expect(short).toEqual({ start: 1, end: 1.6, fadeIn: 0.3, fadeOut: 0.3 });
    expect(layerOpacityAt(short, 1.3)).toBeCloseTo(1, 10);
    expect(layerOpacityAt(short, 1.15)).toBeCloseTo(0.5, 10);
  });
});

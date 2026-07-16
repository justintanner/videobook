import { describe, it, expect } from "vitest";
import {
  splitLayout,
  cardPlacements,
  impactFrames,
  totalDuration,
  buildOutroSpec,
  cardAnimationProgress,
  cardEntryOffset,
  cueWindows,
  orientationForAspectRatio,
  FPS,
  FIRST_IMPACT_FRAME,
  IMPACT_INTERVAL_FRAMES,
  ENTRY_FRAMES,
  CARD_PAD,
  MAX_FINAL_CUE_S,
} from "./qr-outro-spec.js";
import type { AspectRatio } from "./qr-outro-spec.js";

describe("splitLayout", () => {
  it("16:9 → 1920×1080, frame-left / QR-right", () => {
    const l = splitLayout("16:9");
    expect(l.width).toBe(1920);
    expect(l.height).toBe(1080);
    expect(l.frameRect).toEqual({ x: 0, y: 0, w: 960, h: 1080 });
    expect(l.panelRect).toEqual({ x: 960, y: 0, w: 960, h: 1080 });
    expect(l.splitAxis).toBe("horizontal");
  });

  it("9:16 → 1080×1920, frame-top / QR-bottom", () => {
    const l = splitLayout("9:16");
    expect(l.width).toBe(1080);
    expect(l.height).toBe(1920);
    expect(l.frameRect).toEqual({ x: 0, y: 0, w: 1080, h: 960 });
    expect(l.panelRect).toEqual({ x: 0, y: 960, w: 1080, h: 960 });
    expect(l.splitAxis).toBe("vertical");
  });

  it("1:1 → 1080×1080, frame-left / QR-right", () => {
    const l = splitLayout("1:1");
    expect(l.width).toBe(1080);
    expect(l.height).toBe(1080);
    expect(l.frameRect).toEqual({ x: 0, y: 0, w: 540, h: 1080 });
    expect(l.panelRect).toEqual({ x: 540, y: 0, w: 540, h: 1080 });
    expect(l.splitAxis).toBe("horizontal");
  });
});

describe("cardPlacements", () => {
  const ratios: AspectRatio[] = ["16:9", "9:16", "1:1"];

  for (const ratio of ratios) {
    describe(`ratio ${ratio}`, () => {
      const layout = splitLayout(ratio);
      const panel = layout.panelRect;

      for (const count of [1, 2, 3, 4]) {
        it(`${count} QR(s) fit inside panel with padding`, () => {
          const cards = cardPlacements(count, panel, layout.splitAxis);
          expect(cards).toHaveLength(count);

          for (const card of cards) {
            expect(card.x).toBeGreaterThanOrEqual(panel.x + CARD_PAD);
            expect(card.y).toBeGreaterThanOrEqual(panel.y + CARD_PAD);
            expect(card.x + card.w).toBeLessThanOrEqual(panel.x + panel.w - CARD_PAD);
            expect(card.y + card.h).toBeLessThanOrEqual(panel.y + panel.h - CARD_PAD);
            expect(card.w).toBeGreaterThan(0);
            expect(card.h).toBeGreaterThan(0);
            expect(card.w).toBe(card.h);
          }
        });
      }

      it("1 QR is centered", () => {
        const [card] = cardPlacements(1, panel, layout.splitAxis);
        const availW = panel.w - CARD_PAD * 2;
        const availH = panel.h - CARD_PAD * 2;
        const side = Math.min(availW, availH);
        const expectedX = panel.x + CARD_PAD + Math.floor((availW - side) / 2);
        const expectedY = panel.y + CARD_PAD + Math.floor((availH - side) / 2);
        expect(card.x).toBe(expectedX);
        expect(card.y).toBe(expectedY);
      });

      it("2 QRs along panel long axis", () => {
        const cards = cardPlacements(2, panel, layout.splitAxis);
        if (layout.splitAxis === "horizontal") {
          expect(cards[0].y).toBeLessThan(cards[1].y);
          expect(cards[0].x).toBe(cards[1].x);
        } else {
          expect(cards[0].x).toBeLessThan(cards[1].x);
          expect(cards[0].y).toBe(cards[1].y);
        }
      });

      it("3 or 4 QRs in row-major 2×2 grid", () => {
        for (const count of [3, 4]) {
          const cards = cardPlacements(count, panel, layout.splitAxis);
          expect(cards[0].x).toBeLessThan(cards[1].x);
          if (count >= 3) {
            expect(cards[2].x).toBe(cards[0].x);
            expect(cards[2].y).toBeGreaterThan(cards[0].y);
          }
          if (count === 4) {
            expect(cards[3].x).toBe(cards[1].x);
            expect(cards[3].y).toBe(cards[2].y);
          }
        }
      });

      it("cards do not overlap", () => {
        for (const count of [2, 3, 4]) {
          const cards = cardPlacements(count, panel, layout.splitAxis);
          for (let i = 0; i < cards.length; i++) {
            for (let j = i + 1; j < cards.length; j++) {
              const a = cards[i];
              const b = cards[j];
              const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
              const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
              expect(overlapX && overlapY).toBe(false);
            }
          }
        }
      });
    });
  }

  it("rejects qrCount outside 1-4", () => {
    const panel = { x: 0, y: 0, w: 960, h: 1080 };
    expect(() => cardPlacements(0, panel, "horizontal")).toThrow();
    expect(() => cardPlacements(5, panel, "horizontal")).toThrow();
  });
});

describe("impactFrames", () => {
  it("1 QR has single impact at first-impact frame", () => {
    const impacts = impactFrames(1);
    expect(impacts).toHaveLength(1);
    expect(impacts[0].frame).toBe(FIRST_IMPACT_FRAME);
    expect(impacts[0].cardIndex).toBe(0);
  });

  it("4 QRs spaced by IMPACT_INTERVAL", () => {
    const impacts = impactFrames(4);
    expect(impacts).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(impacts[i].frame).toBe(FIRST_IMPACT_FRAME + i * IMPACT_INTERVAL_FRAMES);
      expect(impacts[i].cardIndex).toBe(i);
    }
  });

  it("impacts are in ascending frame order", () => {
    for (const count of [1, 2, 3, 4]) {
      const impacts = impactFrames(count);
      for (let i = 1; i < impacts.length; i++) {
        expect(impacts[i].frame).toBeGreaterThan(impacts[i - 1].frame);
      }
    }
  });
});

describe("totalDuration", () => {
  it("1 QR: max(3.0, 0.4 + 1.6) = 3.0s", () => {
    const dur = totalDuration(1);
    expect(dur.seconds).toBeCloseTo(3.0, 1);
    expect(dur.frames).toBe(Math.round(3.0 * FPS));
  });

  it("2 QRs: max(3.0, 0.8 + 1.6) = 3.0s", () => {
    const dur = totalDuration(2);
    expect(dur.seconds).toBeCloseTo(3.0, 1);
  });

  it("4 QRs: max(3.0, 1.6 + 1.6) = 3.2s", () => {
    const dur = totalDuration(4);
    expect(dur.seconds).toBeCloseTo(3.2, 1);
    expect(dur.frames).toBe(Math.round(3.2 * FPS));
  });

  it("duration always ≥ 3.0s", () => {
    for (const count of [1, 2, 3, 4]) {
      expect(totalDuration(count).seconds).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("frames is consistent with seconds", () => {
    for (const count of [1, 2, 3, 4]) {
      const dur = totalDuration(count);
      expect(dur.frames).toBe(Math.round(dur.seconds * FPS));
    }
  });
});

describe("buildOutroSpec", () => {
  it("builds a complete spec for each ratio × count", () => {
    for (const ratio of ["16:9", "9:16", "1:1"] as AspectRatio[]) {
      for (const count of [1, 2, 3, 4]) {
        const spec = buildOutroSpec(ratio, count);
        expect(spec.fps).toBe(FPS);
        expect(spec.cards).toHaveLength(count);
        expect(spec.impacts).toHaveLength(count);
        expect(spec.totalDurationFrames).toBeGreaterThan(0);
        expect(spec.layout.width).toBeGreaterThan(0);
        expect(spec.layout.height).toBeGreaterThan(0);
      }
    }
  });
});

describe("orientationForAspectRatio", () => {
  it.each([
    ["16:9", "landscape"],
    ["9:16", "portrait"],
    ["1:1", "square"],
  ] as const)("maps %s to %s", (ratio, orientation) => {
    expect(orientationForAspectRatio(ratio)).toBe(orientation);
  });
});

describe("cardAnimationProgress", () => {
  const impact = FIRST_IMPACT_FRAME;

  it("uses one impact interval for the default entrance", () => {
    expect(ENTRY_FRAMES).toBe(IMPACT_INTERVAL_FRAMES);
    expect(impact - ENTRY_FRAMES).toBe(0);
  });

  it("is invisible before the entry window", () => {
    const p = cardAnimationProgress(impact - ENTRY_FRAMES - 1, impact);
    expect(p.visible).toBe(false);
    expect(p.opacity).toBe(0);
  });

  it("starts entering before impact", () => {
    const p = cardAnimationProgress(impact - ENTRY_FRAMES, impact);
    expect(p.visible).toBe(true);
    expect(p.opacity).toBe(0);
    expect(p.translateFraction).toBe(1);
  });

  it("is visibly in motion halfway through the entrance", () => {
    const p = cardAnimationProgress(impact - ENTRY_FRAMES / 2, impact);
    expect(p.visible).toBe(true);
    expect(p.opacity).toBeGreaterThan(0);
    expect(p.opacity).toBeLessThan(1);
    expect(p.translateFraction).toBeGreaterThan(0);
    expect(p.translateFraction).toBeLessThan(1);
  });

  it("lands fully opaque at impact", () => {
    const p = cardAnimationProgress(impact, impact);
    expect(p.visible).toBe(true);
    expect(p.opacity).toBe(1);
    expect(p.translateFraction).toBe(0);
    expect(p.rotation).toBe(0);
    expect(p.scale).toBeLessThan(1);
  });

  it("settles to its final scale after impact", () => {
    const p = cardAnimationProgress(impact + ENTRY_FRAMES, impact);
    expect(p.scale).toBe(1);
  });

  it("card persists indefinitely after landing", () => {
    const p = cardAnimationProgress(impact + 1000, impact);
    expect(p.visible).toBe(true);
    expect(p.opacity).toBe(1);
  });
});

describe("cardEntryOffset", () => {
  it("starts every card fully beyond the output edge", () => {
    for (const ratio of ["16:9", "9:16", "1:1"] as AspectRatio[]) {
      for (const count of [1, 2, 3, 4]) {
        const spec = buildOutroSpec(ratio, count);
        for (const card of spec.cards) {
          const offset = cardEntryOffset(card, spec.layout);
          const radians = 8 * Math.PI / 180;
          const transformedHalfWidth = (
            card.w * 1.2 * Math.cos(radians)
            + card.h * 1.2 * Math.sin(radians)
          ) / 2;
          const transformedHalfHeight = (
            card.w * 1.2 * Math.sin(radians)
            + card.h * 1.2 * Math.cos(radians)
          ) / 2;
          const centerX = card.x + card.w / 2 + offset.x;
          const centerY = card.y + card.h / 2 + offset.y;

          if (spec.layout.splitAxis === "horizontal") {
            expect(centerX - transformedHalfWidth).toBeGreaterThan(spec.layout.width);
          } else {
            expect(centerY - transformedHalfHeight).toBeGreaterThan(spec.layout.height);
          }
        }
      }
    }
  });
});

describe("cueWindows", () => {
  it("1 QR: single cue starting at impact, capped at MAX_FINAL_CUE_S", () => {
    const dur = totalDuration(1);
    const windows = cueWindows(1, dur.frames);
    expect(windows).toHaveLength(1);
    expect(windows[0].startFrame).toBe(FIRST_IMPACT_FRAME);
    const maxEnd = FIRST_IMPACT_FRAME + Math.round(MAX_FINAL_CUE_S * FPS);
    expect(windows[0].endFrame).toBeLessThanOrEqual(maxEnd);
  });

  it("4 QRs: each cue ends before next impact starts", () => {
    const dur = totalDuration(4);
    const windows = cueWindows(4, dur.frames);
    expect(windows).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      expect(windows[i].endFrame).toBe(windows[i + 1].startFrame);
    }
  });

  it("final cue is capped at MAX_FINAL_CUE_S", () => {
    const dur = totalDuration(4);
    const windows = cueWindows(4, dur.frames);
    const last = windows[windows.length - 1];
    const length = (last.endFrame - last.startFrame) / FPS;
    expect(length).toBeLessThanOrEqual(MAX_FINAL_CUE_S + 0.01);
  });

  it("windows cover all impact indices", () => {
    for (const count of [1, 2, 3, 4]) {
      const dur = totalDuration(count);
      const windows = cueWindows(count, dur.frames);
      for (let i = 0; i < count; i++) {
        expect(windows[i].impactIndex).toBe(i);
      }
    }
  });
});

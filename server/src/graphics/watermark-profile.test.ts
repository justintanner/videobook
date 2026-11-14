import { describe, expect, it } from "vitest";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { LIGHTNING_WATERMARK_PROFILE, watermarkWindowsFor, X_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import type { GraphicsTextLayout } from "./layout.js";
import { layoutGraphics } from "./layout.js";
import type { GraphicsDocument, GraphicsFrame, GraphicsPosition, GraphicsQrLayer, GraphicsTextLayer, GraphicsTiming } from "./model.js";
import { GRAPHICS_ANCHOR_POINTS, GRAPHICS_INSET_FRACTION, parseGraphicsDocument } from "./model.js";
import { resolveLayerTiming } from "./timing.js";
import { watermarkDocumentFromProfile, watermarkHandleHeight } from "./watermark-profile.js";

const PROFILES = [["tiktok", { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center" }], ["x", X_WATERMARK_PROFILE]] as const;
const FRAMES: GraphicsFrame[] = [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }];
const CORNERS: OsgPosition[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

type Rect = { x: number; y: number; width: number; height: number };

function built(profile: LightningWatermarkProfile, frame: GraphicsFrame, overrides: Parameters<typeof watermarkDocumentFromProfile>[2] = {}): GraphicsDocument {
  const document = watermarkDocumentFromProfile(profile, frame, overrides);
  expect(parseGraphicsDocument(document)).toEqual({ ok: true, document });
  return document;
}

function qrOf(document: GraphicsDocument): GraphicsQrLayer {
  const layer = document.layers.find((candidate) => candidate.kind === "qr");
  if (!layer || layer.kind !== "qr") throw new Error("expected a QR layer");
  return layer;
}

function handleOf(document: GraphicsDocument): GraphicsTextLayer {
  const layer = document.layers.find((candidate) => candidate.kind === "text");
  if (!layer || layer.kind !== "text") throw new Error("expected a handle layer");
  return layer;
}

function insetSpace(frame: GraphicsFrame): Rect {
  const pad = Math.round(frame.width * GRAPHICS_INSET_FRACTION);
  return { x: pad, y: pad, width: frame.width - 2 * pad, height: frame.height - 2 * pad };
}

function anchorPoint(position: GraphicsPosition, space: Rect): { x: number; y: number } {
  return { x: space.x + position.x * space.width, y: space.y + position.y * space.height };
}

function documentQrPixels(layer: GraphicsQrLayer, frame: GraphicsFrame): { side: number; x: number; y: number } {
  const space = insetSpace(frame);
  const side = Math.max(2, 2 * Math.round((layer.size * Math.min(frame.width, frame.height)) / 2));
  const point = anchorPoint(layer.position, space);
  const anchor = GRAPHICS_ANCHOR_POINTS[layer.position.anchor];
  return { side, x: point.x - anchor.x * side, y: point.y - anchor.y * side };
}

function evenPixels(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

function todayQrBox(profile: LightningWatermarkProfile, frame: GraphicsFrame, corner: OsgPosition): { side: number; x: number; y: number } {
  const side = evenPixels(Math.min(frame.width, frame.height) * 0.16 * profile.scale);
  const padding = Math.round(frame.width * 0.02);
  const [vertical, horizontal] = corner.split("-");
  const x = horizontal === "left" ? padding : horizontal === "right" ? frame.width - side - padding : (frame.width - side) / 2;
  const y = vertical === "top" ? padding : vertical === "bottom" ? frame.height - side - padding : (frame.height - side) / 2;
  return { side, x, y };
}

function todayPillUnits(paddingY: number): number {
  return Math.max(30, 88 + 2 * (paddingY - 32));
}

function textLayout(document: GraphicsDocument, frame: GraphicsFrame, labelPixels: number): GraphicsTextLayout {
  const layout = layoutGraphics({ document, frame, measure: () => labelPixels }).find((entry): entry is GraphicsTextLayout => entry.kind === "text");
  if (!layout) throw new Error("expected a text layout");
  return layout;
}

function resolvedWindow(timing: GraphicsTiming, duration: number): { start: number; end: number } | null {
  const resolved = resolveLayerTiming(timing, duration);
  return resolved && { start: resolved.start, end: resolved.end };
}

function profileWindow(start: number, end: number): { start: number; end: number } | null {
  return end > start ? { start, end } : null;
}

describe("watermark documents from a saved profile", () => {
  it.each(PROFILES.flatMap(([name, profile]) => FRAMES.map((frame) => [name, profile, frame] as const)))(
    "gives the %s profile the burned QR tile side and corner padding at %j",
    (_name, profile, frame) => {
      const qr = qrOf(built(profile, frame, { includeQr: true }));
      expect(qr).toMatchObject({ slot: "profile", style: "tile", dark: "#0B0B0F", light: "#FFFFFF", level: "H", size: 0.16 * profile.scale });
      expect(qr.position).toEqual({ anchor: "bottom-right", x: 1, y: 1, space: "inset" });
      expect(documentQrPixels(qr, frame)).toEqual(todayQrBox(profile, frame, "bottom-right"));
    },
  );

  it.each(CORNERS)("places the QR tile in the %s corner exactly where today's burn put it", (corner) => {
    for (const frame of FRAMES) {
      const qr = qrOf(built(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: true, corner }));
      expect(documentQrPixels(qr, frame)).toEqual(todayQrBox(LIGHTNING_WATERMARK_PROFILE, frame, corner));
    }
  });

  it.each(PROFILES.flatMap(([name, profile]) => [...FRAMES, { width: 720, height: 1280 }].map((frame) => [name, profile, frame] as const)))(
    "sizes the %s handle pill like today's badge pill at %j",
    (_name, profile, frame) => {
      const side = evenPixels(Math.min(frame.width, frame.height) * 0.16 * profile.scale);
      const pill = todayPillUnits(profile.handlePaddingY);
      const height = evenPixels((side * pill) / 88);
      const unit = height / pill;
      const label = 61;
      const layout = textLayout(built(profile, frame), frame, label * unit);
      const plate = layout.plate;
      if (!plate) throw new Error("expected a plate");
      const todayWidth = (Math.ceil(40 + label + 2 * profile.handlePaddingX) + 2) * unit;
      expect(Math.abs(plate.height - height)).toBeLessThanOrEqual(1);
      expect(Math.abs(plate.width - todayWidth)).toBeLessThanOrEqual(2);
      expect(Math.abs(plate.x + plate.width / 2 - frame.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(plate.y + plate.height / 2 - (frame.height * profile.handleVerticalPercent) / 100)).toBeLessThanOrEqual(1);
      expect(watermarkHandleHeight(profile, frame) * Math.min(frame.width, frame.height)).toBeCloseTo(height, 6);
    },
  );

  it("keeps a borderless pill and one without an icon to today's outline", () => {
    const frame = { width: 1080, height: 1920 };
    const profile: LightningWatermarkProfile = { ...X_WATERMARK_PROFILE, includeHandleBorder: false, includePlatformIcon: false, handlePaddingY: 40 };
    const pill = todayPillUnits(40);
    const height = evenPixels((172 * pill) / 88);
    const unit = height / pill;
    const plate = textLayout(built(profile, frame), frame, 100 * unit).plate;
    if (!plate) throw new Error("expected a plate");
    expect(Math.abs(plate.height - (pill - 2) * unit)).toBeLessThanOrEqual(1);
    expect(Math.abs(plate.width - Math.ceil(100 + 2 * profile.handlePaddingX) * unit)).toBeLessThanOrEqual(2);
  });

  it.each(PROFILES)("resolves the %s QR and handle windows to watermarkWindowsFor at every clip length", (_name, profile) => {
    const document = built(profile, { width: 1080, height: 1920 }, { includeQr: true });
    for (const duration of [0.5, 2, 2.3, 3, 8, 12, 30]) {
      const windows = watermarkWindowsFor(profile, duration);
      expect(resolvedWindow(qrOf(document).timing, duration)).toEqual(profileWindow(windows.qrStartSeconds, windows.qrEndSeconds));
      expect(resolvedWindow(handleOf(document).timing, duration)).toEqual(profileWindow(windows.handleStartSeconds, windows.handleEndSeconds));
    }
    expect(qrOf(document).timing.fade).toBe(profile.fadeSeconds);
    expect(handleOf(document).timing.fade).toBe(profile.fadeSeconds);
  });

  it("keeps handle windows that start late or end before they start equal to watermarkWindowsFor", () => {
    const profiles: LightningWatermarkProfile[] = [
      { ...X_WATERMARK_PROFILE, handleStartSeconds: 1.5, handleEndSeconds: null, qrLeadSeconds: 4 },
      { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center", handleStartSeconds: 5, handleEndSeconds: 2 },
    ];
    for (const profile of profiles) {
      const document = built(profile, { width: 1920, height: 1080 }, { includeQr: true });
      for (const duration of [1, 3, 6, 10]) {
        const windows = watermarkWindowsFor(profile, duration);
        expect(resolvedWindow(handleOf(document).timing, duration)).toEqual(profileWindow(windows.handleStartSeconds, windows.handleEndSeconds));
        expect(resolvedWindow(qrOf(document).timing, duration)).toEqual(profileWindow(windows.qrStartSeconds, windows.qrEndSeconds));
      }
    }
  });

  it("adds a QR layer only when includeQr is true, below the handle", () => {
    const frame = { width: 1080, height: 1920 };
    expect(built(LIGHTNING_WATERMARK_PROFILE, frame).layers.map((layer) => layer.kind)).toEqual(["text"]);
    expect(built(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: false }).layers.map((layer) => layer.kind)).toEqual(["text"]);
    expect(built(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: true }).layers.map((layer) => layer.kind)).toEqual(["qr", "text"]);
    expect(built(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: true, includeHandle: false }).layers.map((layer) => layer.kind)).toEqual(["qr"]);
  });

  it.each(PROFILES)("draws the %s handle as one item with its plate, icon, centre line, opacity and fade", (_name, profile) => {
    const handle = handleOf(built(profile, { width: 1080, height: 1920 }, { includeQr: true }));
    expect(handle.position).toEqual({ anchor: "center", x: 0.5, y: profile.handleVerticalPercent / 100, space: "frame" });
    expect(handle.opacity).toBe(profile.handleOpacity);
    expect(handle.align).toBe("center");
    expect(handle.items).toHaveLength(1);
    expect(handle.items[0]).toMatchObject({
      text: profile.handle,
      slot: "handle",
      font: "text",
      maxLines: 1,
      icon: profile.platform,
      color: "#FFFFFF",
    });
    expect(handle.plate).toMatchObject({ color: "#0B0B0F", opacity: 0.92, border: profile.includeHandleBorder, radius: profile.handleRounding / 100 });
    const larger = handleOf(built({ ...profile, scale: 1.5 }, { width: 1080, height: 1920 }));
    expect(larger.items[0].size / handle.items[0].size).toBeCloseTo(1.5, 1);
    expect((larger.plate?.paddingX ?? 0) / (handle.plate?.paddingX ?? 1)).toBeCloseTo(1.5, 1);
  });

  it.each(["above-qr", "on-qr", "below-qr"] as const)("attaches a %s handle to the QR box with the burn's gap", (placement) => {
    const frame = { width: 1080, height: 1920 };
    const corner: OsgPosition = "middle-right";
    const profile: LightningWatermarkProfile = { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: placement };
    const document = built(profile, frame, { includeQr: true, corner });
    const handle = handleOf(document);
    const qr = todayQrBox(profile, frame, corner);
    const gap = Math.max(2, Math.round(qr.side * 0.06));
    const todayY = { "above-qr": qr.y - gap, "on-qr": qr.y + qr.side / 2, "below-qr": qr.y + qr.side + gap }[placement];
    const point = anchorPoint(handle.position, insetSpace(frame));
    expect(documentQrPixels(qrOf(document), frame)).toEqual(qr);
    expect(handle.position.space).toBe("inset");
    expect(handle.position.anchor).toBe({ "above-qr": "bottom", "on-qr": "center", "below-qr": "top" }[placement]);
    expect(Math.abs(point.x - (qr.x + qr.side / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(point.y - todayY)).toBeLessThanOrEqual(1);
  });

  it("pins an attached handle that would leave the frame to the inset edge, and centres it without a QR", () => {
    const profile: LightningWatermarkProfile = { ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "below-qr" };
    const below = handleOf(built(profile, { width: 1080, height: 1920 }, { includeQr: true }));
    expect(below.position).toMatchObject({ anchor: "top", y: 1, space: "inset" });
    const above = handleOf(built({ ...profile, handlePlacement: "above-qr" }, { width: 1080, height: 1920 }, { includeQr: true, corner: "top-left" }));
    expect(above.position).toMatchObject({ anchor: "bottom", y: 0, space: "inset" });
    const alone = handleOf(built(profile, { width: 1080, height: 1920 }));
    expect(alone.position).toEqual({ anchor: "center", x: 0.5, y: 0.1, space: "frame" });
  });

  it("applies apply_watermark overrides and keeps out-of-range profile values inside the schema", () => {
    const document = built(X_WATERMARK_PROFILE, { width: 1920, height: 1080 }, {
      includeQr: true,
      corner: "top-left",
      handle: "@someone",
      includePlatformIcon: false,
      handleOpacity: 0.6,
      scale: 1.5,
      qrWindow: { startSeconds: 1, endSeconds: 4 },
      handleWindow: { startSeconds: null, endSeconds: 2 },
    });
    const qr = qrOf(document);
    expect(qr.position).toEqual({ anchor: "top-left", x: 0, y: 0, space: "inset" });
    expect(qr.size).toBeCloseTo(0.24, 10);
    expect(qr.url).toBe("https://x.com/someone");
    expect(qr.timing).toEqual({ start: 1, end: 4, tail: null, fade: X_WATERMARK_PROFILE.fadeSeconds, enter: "fade", exit: "fade" });
    const handle = handleOf(document);
    expect(handle.items[0]).toMatchObject({ text: "someone", icon: null });
    expect(handle.opacity).toBe(0.6);
    expect(handle.timing).toEqual({ start: null, end: 2, tail: null, fade: X_WATERMARK_PROFILE.fadeSeconds, enter: "fade", exit: "fade" });
    const clamped = built({ ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center" }, { width: 720, height: 1280 }, {
      includeQr: true,
      handleOpacity: 0,
      qrOpacity: 3,
      fadeSeconds: 5,
      scale: 10,
      profileUrl: "not a url",
      handleVerticalPercent: 140,
    });
    expect(qrOf(clamped)).toMatchObject({ opacity: 1, size: 0.6, url: "" });
    expect(handleOf(clamped)).toMatchObject({ opacity: 0.05, timing: { fade: 2 }, position: { y: 0.9 } });
  });

  it("uses the stored profile URL, or the platform URL for the handle when none is stored", () => {
    const frame = { width: 1080, height: 1920 };
    expect(qrOf(built(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: true })).url).toBe("https://www.tiktok.com/@jtbkk");
    expect(qrOf(built(X_WATERMARK_PROFILE, frame, { includeQr: true })).url).toBe("https://x.com/justinwtanner");
    expect(() => watermarkDocumentFromProfile(LIGHTNING_WATERMARK_PROFILE, { width: 0, height: 1920 })).toThrow(/Frame sides/u);
  });
});

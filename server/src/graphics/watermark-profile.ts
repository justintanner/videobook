import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { WATERMARK_MIN_DIM_FRACTION } from "../remotion/osg-spec.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import {
  DEFAULT_HANDLE_VERTICAL_PERCENT,
  MAX_HANDLE_VERTICAL_PERCENT,
  MIN_HANDLE_VERTICAL_PERCENT,
} from "../watermark-handle-position.js";
import type { WatermarkHandlePlacement } from "../watermark-handle-position.js";
import { watermarkProfileUrl } from "../watermark-platform.js";
import { graphicsLineMetrics } from "./fonts.js";
import { GRAPHICS_ICON_SPACE } from "./layout.js";
import type {
  GraphicsAnchor,
  GraphicsDocument,
  GraphicsFontPreset,
  GraphicsFrame,
  GraphicsIcon,
  GraphicsLayerInput,
  GraphicsPlateInput,
  GraphicsPosition,
  GraphicsSpace,
  GraphicsTiming,
} from "./model.js";
import type { GraphicsSlotValues } from "./slots.js";
import {
  definedFields,
  GRAPHICS_ANCHOR_POINTS,
  GRAPHICS_INSET_FRACTION,
  graphicsDocumentFromLayers,
  graphicsFrame,
  isGraphicsUrl,
  MAX_GRAPHICS_FADE_SECONDS,
  MAX_GRAPHICS_PLATE_PADDING,
} from "./model.js";

export type WatermarkWindow = { startSeconds: number | null; endSeconds: number | null };

type ProfileOverrides = Partial<Pick<
  LightningWatermarkProfile,
  | "handle"
  | "profileUrl"
  | "includePlatformIcon"
  | "includeHandleBorder"
  | "handlePaddingX"
  | "handlePaddingY"
  | "handleRounding"
  | "scale"
  | "handlePlacement"
  | "handleVerticalPercent"
  | "handleOpacity"
  | "qrOpacity"
  | "fadeSeconds"
>>;

export type WatermarkDocumentOverrides = ProfileOverrides & {
  includeQr?: boolean;
  includeHandle?: boolean;
  corner?: OsgPosition;
  qrWindow?: WatermarkWindow;
  handleWindow?: WatermarkWindow;
};

type Rect = { x: number; y: number; width: number; height: number };

const QR_DARK = "#0B0B0F";
const QR_LIGHT = "#FFFFFF";
const PILL_COLOR = "#0B0B0F";
const PILL_OPACITY = 0.92;
const HANDLE_TEXT_COLOR = "#FFFFFF";
const BADGE_WIDTH_UNITS = 480;
const BADGE_HANDLE_HEIGHT_UNITS = 88;
const BADGE_PILL_UNITS = 88;
const BADGE_PILL_PADDING_UNITS = 32;
const MIN_BADGE_PILL_UNITS = 30;
const MAX_BADGE_PADDING_UNITS = 96;
const BADGE_ICON_SPACE_UNITS = 40;
const BADGE_STROKE_UNITS = 1;
const HANDLE_FONT: GraphicsFontPreset = "text";
const HANDLE_FONT_UNITS = 25.6;
const ATTACHED_GAP_FRACTION = 0.06;
const MIN_ATTACHED_GAP_PIXELS = 2;
const DEFAULT_CORNER: OsgPosition = "bottom-right";

const CORNER_ANCHORS: Record<OsgPosition, GraphicsAnchor> = {
  "top-left": "top-left",
  "top-center": "top",
  "top-right": "top-right",
  "middle-left": "left",
  "middle-center": "center",
  "middle-right": "right",
  "bottom-left": "bottom-left",
  "bottom-center": "bottom",
  "bottom-right": "bottom-right",
};

const ATTACHED_ANCHORS: Record<Exclude<WatermarkHandlePlacement, "center">, GraphicsAnchor> = {
  "above-qr": "bottom",
  "on-qr": "center",
  "below-qr": "top",
};

function clamp(value: number, min: number, max: number, fallback = min): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function optionalSeconds(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, value);
}

function handleLabel(handle: string): string {
  return handle.trim().replace(/^@+/u, "");
}

function profileUrl(profile: LightningWatermarkProfile): string {
  const handle = handleLabel(profile.handle);
  const url = profile.profileUrl.trim() || (handle ? watermarkProfileUrl(handle, profile.platform) : "");
  return isGraphicsUrl(url) ? url : "";
}

function qrSideFraction(scale: number): number {
  return WATERMARK_MIN_DIM_FRACTION * clamp(scale, 0, Number.MAX_VALUE, 1);
}

function qrSize(scale: number): number {
  return clamp(qrSideFraction(scale), 0.05, 0.6);
}

function spaceRect(frame: GraphicsFrame, space: Exclude<GraphicsSpace, "safe">): Rect {
  const pad = space === "inset" ? frame.width * GRAPHICS_INSET_FRACTION : 0;
  return { x: pad, y: pad, width: frame.width - 2 * pad, height: frame.height - 2 * pad };
}

function platformIcon(profile: LightningWatermarkProfile): GraphicsIcon | null {
  return profile.includePlatformIcon ? profile.platform : null;
}

function cornerPosition(corner: OsgPosition): GraphicsPosition {
  const anchor = CORNER_ANCHORS[corner];
  return { anchor, ...GRAPHICS_ANCHOR_POINTS[anchor], space: "inset" };
}

function windowTiming(window: WatermarkWindow, fade: number): GraphicsTiming {
  return { start: optionalSeconds(window.startSeconds), end: optionalSeconds(window.endSeconds), tail: null, fade };
}

function handleTiming(profile: LightningWatermarkProfile, fade: number): GraphicsTiming {
  const start = optionalSeconds(profile.handleStartSeconds) ?? 0;
  const end = optionalSeconds(profile.handleEndSeconds);
  return { start: start > 0 ? start : null, end: end === null ? null : Math.max(start, end), tail: null, fade };
}

function qrTiming(profile: LightningWatermarkProfile, fade: number): GraphicsTiming {
  return { start: null, end: null, tail: optionalSeconds(profile.qrLeadSeconds), fade };
}

function centeredHandlePosition(verticalPercent: number): GraphicsPosition {
  const percent = clamp(verticalPercent, MIN_HANDLE_VERTICAL_PERCENT, MAX_HANDLE_VERTICAL_PERCENT, DEFAULT_HANDLE_VERTICAL_PERCENT);
  return { anchor: "center", x: 0.5, y: percent / 100, space: "frame" };
}

function attachedPointY(placement: Exclude<WatermarkHandlePlacement, "center">, top: number, side: number, gap: number): number {
  if (placement === "above-qr") return top - gap;
  if (placement === "below-qr") return top + side + gap;
  return top + side / 2;
}

function attachedHandlePosition(
  frame: GraphicsFrame,
  corner: OsgPosition,
  scale: number,
  placement: Exclude<WatermarkHandlePlacement, "center">,
): GraphicsPosition {
  const space = spaceRect(frame, "inset");
  const side = qrSidePixels(frame, scale);
  const point = GRAPHICS_ANCHOR_POINTS[CORNER_ANCHORS[corner]];
  const left = space.x + point.x * (space.width - side);
  const top = space.y + point.y * (space.height - side);
  const gap = Math.max(MIN_ATTACHED_GAP_PIXELS, Math.round(side * ATTACHED_GAP_FRACTION));
  return {
    anchor: ATTACHED_ANCHORS[placement],
    x: clamp((left + side / 2 - space.x) / space.width, 0, 1),
    y: clamp((attachedPointY(placement, top, side, gap) - space.y) / space.height, 0, 1),
    space: "inset",
  };
}

function handleWidth(frame: GraphicsFrame, unit: number, space: Rect): number {
  return clamp((BADGE_WIDTH_UNITS * unit * Math.min(frame.width, frame.height)) / space.width, 0.1, 1);
}

function badgePadding(value: number): number {
  return Math.round(clamp(value, 0, MAX_BADGE_PADDING_UNITS, BADGE_PILL_PADDING_UNITS));
}

function badgePillUnits(paddingY: number): number {
  return Math.max(MIN_BADGE_PILL_UNITS, BADGE_PILL_UNITS + 2 * (badgePadding(paddingY) - BADGE_PILL_PADDING_UNITS));
}

function handleLineUnits(label: string, fontUnits: number): number {
  const metrics = graphicsLineMetrics(HANDLE_FONT, label);
  return fontUnits * (metrics.ascent + metrics.descent);
}

function handlePlate(profile: LightningWatermarkProfile, unit: number, label: string, fontSize: number): GraphicsPlateInput {
  const fontUnits = fontSize / unit;
  const stroke = profile.includeHandleBorder ? BADGE_STROKE_UNITS : 0;
  const outerUnits = badgePillUnits(profile.handlePaddingY) - 2 * BADGE_STROKE_UNITS + 2 * stroke;
  const iconUnits = profile.includePlatformIcon ? (BADGE_ICON_SPACE_UNITS - fontUnits * GRAPHICS_ICON_SPACE) / 2 : 0;
  return {
    color: PILL_COLOR,
    opacity: PILL_OPACITY,
    paddingX: clamp((badgePadding(profile.handlePaddingX) + iconUnits + stroke) * unit, 0, MAX_GRAPHICS_PLATE_PADDING),
    paddingY: clamp(((outerUnits - handleLineUnits(label, fontUnits)) / 2) * unit, 0, MAX_GRAPHICS_PLATE_PADDING),
    radius: clamp(profile.handleRounding / 100, 0, 1, 1),
    border: profile.includeHandleBorder,
  };
}

function evenPixels(value: number): number {
  return Math.max(2, 2 * Math.round(value / 2));
}

function qrSidePixels(frame: GraphicsFrame, scale: number): number {
  return evenPixels(qrSize(scale) * Math.min(frame.width, frame.height));
}

function handlePixels(frame: GraphicsFrame, profile: LightningWatermarkProfile): number {
  return evenPixels((qrSidePixels(frame, profile.scale) * badgePillUnits(profile.handlePaddingY)) / BADGE_HANDLE_HEIGHT_UNITS);
}

function badgeUnit(frame: GraphicsFrame, profile: LightningWatermarkProfile, attached: boolean): number {
  const short = Math.min(frame.width, frame.height);
  if (attached) return qrSidePixels(frame, profile.scale) / BADGE_WIDTH_UNITS / short;
  return handlePixels(frame, profile) / badgePillUnits(profile.handlePaddingY) / short;
}

export function watermarkHandleHeight(profile: LightningWatermarkProfile, frame: GraphicsFrame): number {
  return handlePixels(frame, profile) / Math.min(frame.width, frame.height);
}

function handleLayer(
  profile: LightningWatermarkProfile,
  frame: GraphicsFrame,
  corner: OsgPosition,
  placement: WatermarkHandlePlacement,
  timing: GraphicsTiming,
): GraphicsLayerInput {
  const attached = placement === "center" ? null : placement;
  const unit = badgeUnit(frame, profile, attached !== null);
  const label = handleLabel(profile.handle);
  const fontSize = clamp(HANDLE_FONT_UNITS * unit, 0.01, 0.3);
  return {
    kind: "text",
    name: "Handle",
    opacity: clamp(profile.handleOpacity, 0.05, 1, 1),
    timing,
    position: attached
      ? attachedHandlePosition(frame, corner, profile.scale, attached)
      : centeredHandlePosition(profile.handleVerticalPercent),
    width: handleWidth(frame, unit, spaceRect(frame, attached ? "inset" : "frame")),
    align: "center",
    gap: 0,
    plate: handlePlate(profile, unit, label, fontSize),
    items: [{
      text: label,
      slot: "handle",
      font: HANDLE_FONT,
      size: fontSize,
      color: HANDLE_TEXT_COLOR,
      case: "none",
      maxLines: 1,
      icon: platformIcon(profile),
      accent: "none",
      outline: false,
      shadow: false,
    }],
  };
}

function qrLayer(profile: LightningWatermarkProfile, corner: OsgPosition, timing: GraphicsTiming): GraphicsLayerInput {
  return {
    kind: "qr",
    name: "QR code",
    opacity: clamp(profile.qrOpacity, 0.05, 1, 1),
    timing,
    url: profileUrl(profile),
    slot: "profile",
    position: cornerPosition(corner),
    size: qrSize(profile.scale),
    style: "tile",
    dark: QR_DARK,
    light: QR_LIGHT,
    level: "H",
  };
}

export function watermarkSlotValues(profile: LightningWatermarkProfile): GraphicsSlotValues {
  const handle = handleLabel(profile.handle);
  const url = profileUrl(profile);
  return { ...(handle ? { handle } : {}), ...(url ? { profile: url } : {}) };
}

export function watermarkLayerInputs(
  profile: LightningWatermarkProfile,
  frame: GraphicsFrame,
  overrides: WatermarkDocumentOverrides = {},
): GraphicsLayerInput[] {
  const size = graphicsFrame(frame);
  const merged: LightningWatermarkProfile = { ...profile, ...definedFields(overrides) };
  const includeQr = overrides.includeQr ?? false;
  const corner = overrides.corner ?? (merged.qrPosition === "auto" ? DEFAULT_CORNER : merged.qrPosition);
  const fade = clamp(merged.fadeSeconds, 0, MAX_GRAPHICS_FADE_SECONDS, 0);
  const qr = includeQr
    ? [qrLayer(merged, corner, overrides.qrWindow ? windowTiming(overrides.qrWindow, fade) : qrTiming(merged, fade))]
    : [];
  if (overrides.includeHandle === false) return qr;
  const placement = includeQr ? merged.handlePlacement : "center";
  const timing = overrides.handleWindow ? windowTiming(overrides.handleWindow, fade) : handleTiming(merged, fade);
  return [...qr, handleLayer(merged, size, corner, placement, timing)];
}

export function watermarkDocumentFromProfile(
  profile: LightningWatermarkProfile,
  frame: GraphicsFrame,
  overrides: WatermarkDocumentOverrides = {},
): GraphicsDocument {
  return graphicsDocumentFromLayers(watermarkLayerInputs(profile, frame, overrides));
}

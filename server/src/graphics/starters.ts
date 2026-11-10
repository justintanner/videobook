import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { LIGHTNING_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type {
  GraphicsAccent,
  GraphicsDocument,
  GraphicsFontPreset,
  GraphicsFrame,
  GraphicsLayerInput,
  GraphicsPlateInput,
  GraphicsTextItemInput,
  GraphicsTextLayerInput,
  GraphicsTextSlot,
} from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";
import { watermarkDocumentFromProfile, watermarkLayerInputs } from "./watermark-profile.js";

export type GraphicsStarterId = "tiktok-title" | "lower-third" | "headline" | "credit" | "watermark";

export type GraphicsStarter = {
  id: GraphicsStarterId;
  name: string;
  build: (frame: GraphicsFrame, profile?: LightningWatermarkProfile) => GraphicsDocument;
};

export const DEFAULT_GRAPHICS_STARTER_ID: GraphicsStarterId = "tiktok-title";

const WHITE = "#FFFFFF";
const SHADE = "#000000";
const BLOCK_WIDTH = 0.86;
const STARTER_FONT: GraphicsFontPreset = "heavy";
const HEADLINE_ACCENT: GraphicsAccent = "brush";

function slotItem(slot: GraphicsTextSlot, size: number, overrides: GraphicsTextItemInput): GraphicsTextItemInput {
  return {
    text: "",
    slot,
    font: STARTER_FONT,
    size,
    color: WHITE,
    case: "none",
    icon: null,
    accent: "none",
    outline: false,
    shadow: true,
    ...overrides,
  };
}

function edgeShade(edge: "top" | "bottom", height: number, strength: number): GraphicsLayerInput {
  return { kind: "scrim", name: "Shade", edge, height, color: SHADE, strength };
}

function bottomLeftBlock(
  name: string,
  gap: number,
  items: GraphicsTextItemInput[],
  plate: GraphicsPlateInput | null = null,
): GraphicsTextLayerInput {
  return {
    kind: "text",
    name,
    position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
    width: BLOCK_WIDTH,
    align: "left",
    gap,
    plate,
    items,
  };
}

function tiktokTitle(frame: GraphicsFrame, profile: LightningWatermarkProfile = LIGHTNING_WATERMARK_PROFILE): GraphicsDocument {
  return graphicsDocumentFromLayers([
    edgeShade("bottom", 0.5, 0.75),
    bottomLeftBlock("Title", 0.02, [
      slotItem("headline", 0.09, { maxLines: 3, accent: HEADLINE_ACCENT }),
      slotItem("secondary", 0.045, { maxLines: 2 }),
    ]),
    ...watermarkLayerInputs(profile, frame, { includeQr: false }),
  ]);
}

function lowerThird(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    edgeShade("bottom", 0.45, 0.75),
    bottomLeftBlock("Lower third", 0.016, [
      slotItem("headline", 0.068, { maxLines: 4, accent: HEADLINE_ACCENT }),
      slotItem("secondary", 0.044, { maxLines: 2 }),
      slotItem("credit", 0.03, { maxLines: 1, icon: "camera" }),
    ]),
  ]);
}

function headline(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    edgeShade("top", 0.35, 0.6),
    {
      kind: "text",
      name: "Headline",
      position: { anchor: "top", x: 0.5, y: 0, space: "safe" },
      width: 0.9,
      align: "center",
      gap: 0.012,
      plate: null,
      items: [slotItem("headline", 0.08, { maxLines: 3, font: "display", case: "upper" })],
    },
  ]);
}

function credit(): GraphicsDocument {
  const plate = { color: SHADE, opacity: 0.55, paddingX: 0.014, paddingY: 0.008, radius: 1, border: false };
  return graphicsDocumentFromLayers([
    bottomLeftBlock("Credit", 0, [slotItem("credit", 0.03, { maxLines: 1, icon: "camera", shadow: false })], plate),
  ]);
}

function watermark(frame: GraphicsFrame, profile: LightningWatermarkProfile = LIGHTNING_WATERMARK_PROFILE): GraphicsDocument {
  return watermarkDocumentFromProfile(profile, frame, { includeQr: true });
}

export const GRAPHICS_STARTERS: readonly GraphicsStarter[] = [
  { id: "tiktok-title", name: "TikTok title", build: tiktokTitle },
  { id: "lower-third", name: "Lower third", build: lowerThird },
  { id: "headline", name: "Headline", build: headline },
  { id: "credit", name: "Credit", build: credit },
  { id: "watermark", name: "Watermark", build: watermark },
];

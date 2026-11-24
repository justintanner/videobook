import type { GraphicsAnchor, GraphicsDocument, GraphicsImageLayer, GraphicsImageLayerInput, GraphicsPosition } from "./model.js";
import { definedFields, GRAPHICS_ANCHOR_POINTS, graphicsDocumentFromLayers, isGraphicsLogoLayer, parseGraphicsDocument } from "./model.js";

export type GraphicsLogo = { artifactId: string; position: GraphicsPosition; size: number; opacity: number };

export type GraphicsLogoInput = {
  artifactId: string;
  position?: Partial<GraphicsPosition>;
  size?: number;
  opacity?: number;
};

export type GraphicsLogoResult = { ok: true; logo: GraphicsLogo } | { ok: false; error: string };

export const GRAPHICS_LOGO_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const satisfies readonly GraphicsAnchor[];
export type GraphicsLogoCorner = typeof GRAPHICS_LOGO_CORNERS[number];

export const GRAPHICS_LOGO_NAME = "Logo";
export const DEFAULT_GRAPHICS_LOGO_CORNER: GraphicsLogoCorner = "bottom-right";
export const DEFAULT_GRAPHICS_LOGO_SIZE = 0.15;
export const DEFAULT_GRAPHICS_LOGO_OPACITY = 0.8;

export function graphicsLogoCornerPosition(corner: GraphicsLogoCorner): GraphicsPosition {
  return { anchor: corner, ...GRAPHICS_ANCHOR_POINTS[corner], space: "safe" };
}

export function graphicsLogoCorner(position: GraphicsPosition): GraphicsLogoCorner | null {
  return GRAPHICS_LOGO_CORNERS.find((corner) => {
    const point = GRAPHICS_ANCHOR_POINTS[corner];
    return position.anchor === corner && position.space === "safe" && position.x === point.x && position.y === point.y;
  }) ?? null;
}

export function graphicsLogoLayerInput(logo: GraphicsLogo): GraphicsImageLayerInput {
  return {
    kind: "image",
    name: GRAPHICS_LOGO_NAME,
    role: "logo",
    artifactId: logo.artifactId,
    position: logo.position,
    size: logo.size,
    opacity: logo.opacity,
  };
}

export function graphicsLogoOf(layer: GraphicsImageLayer): GraphicsLogo {
  return { artifactId: layer.artifactId, position: layer.position, size: layer.size, opacity: layer.opacity };
}

export function graphicsLogoLayer(document: GraphicsDocument): GraphicsImageLayer | null {
  return document.layers.find(isGraphicsLogoLayer) ?? null;
}

export function withoutGraphicsLogos(document: GraphicsDocument): GraphicsDocument {
  return { ...document, layers: document.layers.filter((layer) => !isGraphicsLogoLayer(layer)) };
}

export function sameGraphicsLogo(left: GraphicsLogo | null, right: GraphicsLogo | null): boolean {
  if (!left || !right) return left === right;
  return left.artifactId === right.artifactId
    && left.size === right.size
    && left.opacity === right.opacity
    && left.position.anchor === right.position.anchor
    && left.position.space === right.position.space
    && left.position.x === right.position.x
    && left.position.y === right.position.y;
}

export function graphicsLogoFrom(input: GraphicsLogoInput): GraphicsLogoResult {
  const position = { ...graphicsLogoCornerPosition(DEFAULT_GRAPHICS_LOGO_CORNER), ...definedFields(input.position ?? {}) };
  const logo = {
    artifactId: input.artifactId,
    position,
    size: input.size ?? DEFAULT_GRAPHICS_LOGO_SIZE,
    opacity: input.opacity ?? DEFAULT_GRAPHICS_LOGO_OPACITY,
  };
  const parsed = parseGraphicsDocument(graphicsDocumentFromLayers([graphicsLogoLayerInput(logo)]));
  if (!parsed.ok) return { ok: false, error: parsed.error.replace(/^layers\[0\]\./u, "") };
  const layer = parsed.document.layers[0];
  return layer.kind === "image" ? { ok: true, logo: graphicsLogoOf(layer) } : { ok: false, error: "A logo is an image." };
}

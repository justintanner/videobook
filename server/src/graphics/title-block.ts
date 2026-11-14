import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import type { GraphicsPlateInput, GraphicsTextItemInput, GraphicsTextLayerInput } from "./model.js";

export function bottomLeftBlock(
  name: string,
  gap: number,
  items: GraphicsTextItemInput[],
  plate: GraphicsPlateInput | null = null,
): GraphicsTextLayerInput {
  return {
    kind: "text",
    name,
    position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
    width: 0.86,
    align: "left",
    gap,
    plate,
    items,
  };
}

export function titleHandleItem(profile: LightningWatermarkProfile): GraphicsTextItemInput {
  return {
    text: profile.handle.trim().replace(/^@+/u, ""),
    slot: "handle",
    font: "heavy",
    size: 0.036,
    color: "#FFFFFF",
    case: "none",
    maxLines: 1,
    icon: profile.includePlatformIcon ? profile.platform : null,
    accent: "none",
    outline: false,
    shadow: true,
  };
}

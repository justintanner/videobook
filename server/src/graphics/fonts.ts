import type { GraphicsFontPreset } from "./model.js";

export type GraphicsFontFace = { family: string; weight: number };
export type GraphicsLineMetrics = { ascent: number; descent: number };

type FontFamily = GraphicsLineMetrics & { name: string };

const MONTSERRAT: FontFamily = { name: "Montserrat", ascent: 968 / 1000, descent: 251 / 1000 };
const ANTON: FontFamily = { name: "Anton", ascent: 2409 / 2048, descent: 674 / 2048 };
const NOTO_SANS_THAI: FontFamily = { name: "Noto Sans Thai", ascent: 1061 / 1000, descent: 450 / 1000 };
const SYSTEM_SANS = "sans-serif";
const THAI_SCRIPT = /\p{Script=Thai}/u;

const PRESETS: Record<GraphicsFontPreset, { primary: FontFamily; weight: number }> = {
  heavy: { primary: MONTSERRAT, weight: 800 },
  display: { primary: ANTON, weight: 400 },
  text: { primary: NOTO_SANS_THAI, weight: 500 },
};

function presetFamilies(preset: GraphicsFontPreset): FontFamily[] {
  const { primary } = PRESETS[preset];
  return primary === NOTO_SANS_THAI ? [primary] : [primary, NOTO_SANS_THAI];
}

export function graphicsPresetFont(preset: GraphicsFontPreset): GraphicsFontFace {
  const family = [...presetFamilies(preset).map((font) => `"${font.name}"`), SYSTEM_SANS].join(", ");
  return { family, weight: PRESETS[preset].weight };
}

export function graphicsLineMetrics(preset: GraphicsFontPreset, text: string): GraphicsLineMetrics {
  const families = presetFamilies(preset);
  const used = THAI_SCRIPT.test(text) ? families : families.slice(0, 1);
  return {
    ascent: Math.max(...used.map((font) => font.ascent)),
    descent: Math.max(...used.map((font) => font.descent)),
  };
}

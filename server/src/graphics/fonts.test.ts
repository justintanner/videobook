import { describe, expect, it } from "vitest";
import { graphicsLineMetrics, graphicsPresetFont } from "./fonts.js";

const THAI = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";

describe("graphics font presets", () => {
  it("names each preset's family first, then the Thai-capable family, then the system sans", () => {
    expect(graphicsPresetFont("heavy")).toEqual({ family: "\"Montserrat\", \"Noto Sans Thai\", sans-serif", weight: 800 });
    expect(graphicsPresetFont("display")).toEqual({ family: "\"Anton\", \"Noto Sans Thai\", sans-serif", weight: 400 });
    expect(graphicsPresetFont("text")).toEqual({ family: "\"Noto Sans Thai\", sans-serif", weight: 500 });
  });

  it("takes line metrics from the preset's font, and from the Thai family too once the text holds Thai", () => {
    expect(graphicsLineMetrics("heavy", "Red light")).toEqual({ ascent: 0.968, descent: 0.251 });
    expect(graphicsLineMetrics("heavy", `${THAI} 2026`)).toEqual({ ascent: 1.061, descent: 0.45 });
    expect(graphicsLineMetrics("display", "RED LIGHT")).toEqual({ ascent: 2409 / 2048, descent: 674 / 2048 });
    expect(graphicsLineMetrics("display", THAI)).toEqual({ ascent: 2409 / 2048, descent: 0.45 });
    expect(graphicsLineMetrics("text", "Red light")).toEqual({ ascent: 1.061, descent: 0.45 });
  });
});

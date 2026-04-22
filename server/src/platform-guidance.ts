export type Platform = "ig" | "tiktok" | "youtube";

export function platformGuidance(p: Platform): string {
  switch (p) {
    case "ig":
      return (
        "PLATFORM: Instagram. Target 4:5 portrait or 1:1 square framing. " +
        "Aesthetic-candid register — curated but unstaged: natural daylight or soft indoor light, " +
        "warm/golden cast acceptable, light film grain tolerated. Mild VSCO-style lift in shadows; " +
        "skin kept natural with no heavy beautify. Avoid HDR crunch, over-saturation, and harsh " +
        "on-camera flash unless the image is clearly a flash-aesthetic shot. Default device read: " +
        "iPhone main camera. Never use editorial/film-stock vocabulary unless the image is clearly " +
        "a professional editorial photo."
      );
    case "tiktok":
      return (
        "PLATFORM: TikTok. Target 9:16 vertical framing. Raw phone snapshot energy — candid framing, " +
        "slight motion softness, mild compression artifacts, auto-HDR lifted blacks. Indoor scenes: " +
        "ring-light rim or warm tungsten acceptable; at night, harsh on-camera flash is on-brand. " +
        "Front-camera selfies (with visible mirror/arm) are native to the platform. Skin unretouched, " +
        "tiny chromatic aberration on high-contrast edges. Never apply editorial polish, cinematic " +
        "color grading, or named film-stock vocabulary (Portra, Cinestill, etc.). No 'cinematic', " +
        "'masterpiece', 'editorial' — this is a phone snapshot."
      );
    case "youtube":
      return (
        "PLATFORM: YouTube. Default to 16:9 landscape unless the image is clearly a Short (then 9:16). " +
        "Slightly elevated production versus TikTok: punchier contrast, cleaner key light, faces " +
        "expressive and readable at small thumbnail sizes. Colour can sit slightly saturated for " +
        "thumbnail legibility but avoid over-stylised filters. Keep the result photographic rather " +
        "than graphic-design; no logo overlays, no title text baked in."
      );
  }
}

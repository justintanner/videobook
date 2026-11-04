export const H3_REFRAME_DESCRIPTION = "Reframe expands the surroundings of a video, preserving its existing picture, audio and timing. Choose a different aspect ratio to leave space to outpaint. The prompt describes the new surroundings; use a video editing model to change the existing picture.";

export function isH3ReframeModel(model: string): boolean {
  return model === "fal:minimax/h3-max/reframe-video" || model === "minimax/h3-max/reframe-video";
}

const NATIVE_768_CANVASES: Readonly<Record<string, readonly [number, number]>> = {
  "16:9": [1344, 768],
  "9:16": [768, 1344],
};

export function reframeVideoGeometryError(options: Record<string, unknown>, width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const aspect = options.aspect_ratio ?? "16:9";
  const resolution = options.resolution ?? "768p";
  const canvas: readonly [number, number] | undefined = aspect === "1:1" ? [1, 1]
    : (resolution === "768p" || resolution === "1080p") && typeof aspect === "string" ? NATIVE_768_CANVASES[aspect] : undefined;
  if (!canvas || width * canvas[1] !== height * canvas[0]) return null;
  return `H3 Reframe: the ${width}×${height} source fills the ${aspect} canvas at ${resolution}, leaving no area to outpaint. Choose a different aspect ratio, or use a video editing model to change the existing picture.`;
}

export function reframeVideoFailure(model: unknown, message: string): string {
  if (typeof model !== "string" || !isH3ReframeModel(model) || !message.includes("leave no area to outpaint")) return message;
  return `${message}. Choose a different aspect ratio to expand the surroundings, or use a video editing model to change the existing picture.`;
}

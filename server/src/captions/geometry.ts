export interface Rational {
  numerator: number;
  denominator: number;
}

export interface CodedVideoGeometry {
  width: number;
  height: number;
  rotationDegrees: number;
  pixelAspect: Rational;
}

const OUTPUT_FPS_STEPS = [24, 25, 30, 50, 60] as const;
const DEFAULT_OUTPUT_FPS = 30;

function rationalValue(value: Rational | undefined): number | null {
  if (!value || !Number.isFinite(value.numerator) || !Number.isFinite(value.denominator) || value.denominator === 0) return null;
  const result = value.numerator / value.denominator;
  return result > 0 ? result : null;
}

export function displayDimensions(geometry: CodedVideoGeometry): { width: number; height: number } {
  const aspect = rationalValue(geometry.pixelAspect) ?? 1;
  const width = Math.max(1, Math.round(geometry.width * aspect));
  const height = Math.max(1, geometry.height);
  const quarterTurns = Math.round(geometry.rotationDegrees / 90);
  return Math.abs(quarterTurns) % 2 === 1 ? { width: height, height: width } : { width, height };
}

export function captionOutputFps(average: Rational | undefined, nominal: Rational | undefined): number {
  const fps = rationalValue(average) ?? rationalValue(nominal);
  if (fps === null || fps > 61) return DEFAULT_OUTPUT_FPS;
  return OUTPUT_FPS_STEPS.reduce((best, step) => (Math.abs(step - fps) < Math.abs(best - fps) ? step : best), DEFAULT_OUTPUT_FPS);
}

export function containRect(source: { width: number; height: number }, target: { width: number; height: number }) {
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (target.width - width) / 2, y: (target.height - height) / 2, width, height };
}

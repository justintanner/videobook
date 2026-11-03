import type { ItemParamSpec } from "./types.js";

export function evenKeyframeSeconds(duration: number, count: number, index: number): number {
  return Math.round((duration * (index + 1) / (count + 1)) * 100) / 100;
}

export function itemParamDefault(spec: ItemParamSpec, duration: number, count: number, index: number): number | undefined {
  return spec.computedDefault === "even_seconds" ? evenKeyframeSeconds(duration, count, index) : spec.defaultValue;
}

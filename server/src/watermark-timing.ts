import type { WatermarkWindow } from "./graphics/watermark-profile.js";
import type { LightningWatermarkProfile, StoredWatermarkProfile } from "./lightning-defaults.js";
import { watermarkWindowsFor } from "./lightning-defaults.js";

export type WatermarkTimes = {
  qrStartSeconds?: number;
  qrEndSeconds?: number;
  handleStartSeconds?: number;
  handleEndSeconds?: number;
};

export function effectiveWatermarkTiming(
  label: string,
  duration: number,
  startSeconds?: number,
  endSeconds?: number,
): { startSeconds?: number; endSeconds?: number } {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video has no usable duration");
  const effectiveStart = startSeconds ?? 0;
  if (effectiveStart < 0 || effectiveStart >= duration) {
    throw new Error(`${label} start must be before the ${duration.toFixed(2)}s clip end`);
  }
  const effectiveEnd = endSeconds === undefined ? undefined : Math.min(endSeconds, duration);
  if (effectiveEnd !== undefined && effectiveEnd <= effectiveStart) {
    throw new Error(`${label} end must be after its start`);
  }
  return {
    ...(startSeconds !== undefined ? { startSeconds } : {}),
    ...(effectiveEnd !== undefined ? { endSeconds: effectiveEnd } : {}),
  };
}

export function watermarkWindow(label: string, duration: number, startSeconds?: number, endSeconds?: number): WatermarkWindow {
  const timing = effectiveWatermarkTiming(label, duration, startSeconds, endSeconds);
  return { startSeconds: timing.startSeconds ?? null, endSeconds: timing.endSeconds ?? null };
}

function storedSeconds(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function storedTimes(stored: StoredWatermarkProfile): WatermarkTimes {
  const times: WatermarkTimes = {
    qrStartSeconds: storedSeconds(stored.qrStartSeconds),
    qrEndSeconds: storedSeconds(stored.qrEndSeconds),
    handleStartSeconds: storedSeconds(stored.handleStartSeconds),
    handleEndSeconds: storedSeconds(stored.handleEndSeconds),
  };
  return Object.fromEntries(Object.entries(times).filter(([, value]) => value !== undefined));
}

export function profileWatermarkTimes(
  stored: StoredWatermarkProfile | undefined,
  profile: LightningWatermarkProfile,
  durationSeconds: number,
): WatermarkTimes {
  if (stored && (typeof stored.qrStartSeconds === "number" || typeof stored.qrEndSeconds === "number")) return storedTimes(stored);
  if (profile.handleEndSeconds == null && profile.qrLeadSeconds == null) return {};
  return watermarkWindowsFor(profile, durationSeconds);
}

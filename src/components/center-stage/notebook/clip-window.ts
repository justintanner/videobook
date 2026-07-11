/** 0.01-second precision for notebook clip window controls. */
export const CLIP_PRECISION = 0.01

export interface ClipBounds {
  min: number
  max: number
}

export interface ClipSchemaBounds {
  minimum?: number
  maximum?: number
}

/** Round to CLIP_PRECISION (two decimal places). */
export function roundClip(value: number): number {
  return Math.round(value / CLIP_PRECISION) * CLIP_PRECISION
}

/**
 * Intersection of start/ends schema bounds when both are finite and form a
 * non-empty open interval (min < max). Returns null when dual-range cannot apply.
 */
export function sharedFiniteBounds(
  startSchema: ClipSchemaBounds | undefined,
  endsSchema: ClipSchemaBounds | undefined,
): ClipBounds | null {
  if (!startSchema || !endsSchema) return null
  const startMin = startSchema.minimum
  const startMax = startSchema.maximum
  const endsMin = endsSchema.minimum
  const endsMax = endsSchema.maximum
  if (
    !Number.isFinite(startMin)
    || !Number.isFinite(startMax)
    || !Number.isFinite(endsMin)
    || !Number.isFinite(endsMax)
  ) {
    return null
  }
  const min = Math.max(startMin as number, endsMin as number)
  const max = Math.min(startMax as number, endsMax as number)
  if (!(min < max)) return null
  return { min, max }
}

export function clampClip(value: number, bounds: ClipBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, roundClip(value)))
}

/**
 * Clamp start/end to bounds, enforce 0.01 precision, and keep start strictly less
 * than end (nudges the opposite handle by CLIP_PRECISION when needed).
 */
export function normalizeClipWindow(
  start: number,
  ends: number,
  bounds: ClipBounds,
): { start: number; ends: number } {
  let s = clampClip(start, bounds)
  let e = clampClip(ends, bounds)
  if (s < e) return { start: s, ends: e }

  // Prefer expanding ends first when room exists above start.
  if (s + CLIP_PRECISION <= bounds.max) {
    e = clampClip(s + CLIP_PRECISION, bounds)
    if (s < e) return { start: s, ends: e }
  }
  s = clampClip(e - CLIP_PRECISION, bounds)
  if (s < e) return { start: s, ends: e }

  // Degenerate bounds (width < precision): pin to min and min+precision if possible.
  s = bounds.min
  e = Math.min(bounds.max, roundClip(bounds.min + CLIP_PRECISION))
  if (s >= e) e = bounds.max
  return { start: roundClip(s), ends: roundClip(e) }
}

export function isClipUnset(start: unknown, ends: unknown): boolean {
  return (start === undefined || start === null) && (ends === undefined || ends === null)
}

/** Display values: unset shows full range without implying persistence. */
export function displayClipWindow(
  start: unknown,
  ends: unknown,
  bounds: ClipBounds,
): { start: number; ends: number; unset: boolean } {
  if (isClipUnset(start, ends)) {
    return { start: bounds.min, ends: bounds.max, unset: true }
  }
  const s = typeof start === 'number' && Number.isFinite(start) ? start : bounds.min
  const e = typeof ends === 'number' && Number.isFinite(ends) ? ends : bounds.max
  const normalized = normalizeClipWindow(s, e, bounds)
  return { ...normalized, unset: false }
}

/** Payload keys written on interaction (original video-edit parameter names). */
export function clipWindowPayload(
  start: number,
  ends: number,
): { video_clip_start: number; video_clip_ends: number } {
  return {
    video_clip_start: roundClip(start),
    video_clip_ends: roundClip(ends),
  }
}

/**
 * Ensure video_clip_start/ends match what the clip-window UI displays so v2v
 * submit / tool-call previews include the window. Unset → full bounds; partial
 * → normalized against bounds. No-op when dual-range bounds are unavailable.
 */
export function withEffectiveClipWindow(
  values: Record<string, unknown>,
  bounds: ClipBounds | null,
): Record<string, unknown> {
  if (!bounds) return values
  const display = displayClipWindow(values.video_clip_start, values.video_clip_ends, bounds)
  return {
    ...values,
    ...clipWindowPayload(display.start, display.ends),
  }
}

export const SPEED_MIN = 0.25
export const SPEED_MAX = 4
export const SPEED_PRESETS = [0.5, 0.75, 1.25, 1.5, 2, 3] as const
const MIN_SECTION_SECONDS = 0.1
const SPEED_PARAM_KEYS = new Set(['speed', 'target_duration_seconds', 'start_seconds', 'end_seconds'])

export interface SpeedChangeSection {
  startSeconds: number
  endSeconds: number
}

export interface SpeedChangeDraft {
  speed: number | null
  targetSeconds: number | null
  section: SpeedChangeSection | null
}

export interface SpeedChangeOutcome {
  effectiveSpeed: number | null
  sectionStartSeconds: number
  sectionEndSeconds: number | null
  outputSeconds: number | null
  error: string | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100
}

export function speedChangeDraftFromParams(params: Record<string, unknown>): SpeedChangeDraft {
  const start = finite(params.start_seconds)
  const end = finite(params.end_seconds)
  return {
    speed: finite(params.speed),
    targetSeconds: finite(params.target_duration_seconds),
    section: start === null && end === null
      ? null
      : { startSeconds: start ?? 0, endSeconds: end ?? Number.POSITIVE_INFINITY },
  }
}

export function speedChangeParams(
  params: Record<string, unknown>,
  draft: SpeedChangeDraft,
): Record<string, unknown> {
  const rest = Object.fromEntries(
    Object.entries(params).filter(([key]) => !SPEED_PARAM_KEYS.has(key)),
  )
  return {
    ...rest,
    ...(draft.speed !== null ? { speed: draft.speed } : {}),
    ...(draft.speed === null && draft.targetSeconds !== null
      ? { target_duration_seconds: draft.targetSeconds }
      : {}),
    ...(draft.section
      ? {
          start_seconds: draft.section.startSeconds,
          ...(Number.isFinite(draft.section.endSeconds) ? { end_seconds: draft.section.endSeconds } : {}),
        }
      : {}),
  }
}

export function clampSection(
  section: SpeedChangeSection,
  durationSeconds: number,
): SpeedChangeSection {
  const end = Math.min(Math.max(section.endSeconds, MIN_SECTION_SECONDS), durationSeconds)
  const start = Math.min(Math.max(0, section.startSeconds), end - MIN_SECTION_SECONDS)
  return { startSeconds: roundHundredths(start), endSeconds: roundHundredths(end) }
}

export function lastSecondsSection(
  seconds: number,
  durationSeconds: number,
): SpeedChangeSection {
  return clampSection(
    { startSeconds: durationSeconds - seconds, endSeconds: durationSeconds },
    durationSeconds,
  )
}

function sectionBounds(
  section: SpeedChangeSection | null,
  durationSeconds: number | null,
): { start: number; end: number | null } {
  if (!section) return { start: 0, end: durationSeconds }
  const end = durationSeconds === null
    ? (Number.isFinite(section.endSeconds) ? section.endSeconds : null)
    : Math.min(section.endSeconds, durationSeconds)
  return { start: section.startSeconds, end }
}

function speedFromTarget(
  targetSeconds: number,
  start: number,
  end: number | null,
  durationSeconds: number | null,
): number | null {
  if (durationSeconds === null || end === null) return null
  const untouched = durationSeconds - (end - start)
  return targetSeconds > untouched ? (end - start) / (targetSeconds - untouched) : null
}

function outcomeError(
  speed: number | null,
  start: number,
  end: number | null,
): string | null {
  if (end !== null && end - start < MIN_SECTION_SECONDS) {
    return `The section must be at least ${MIN_SECTION_SECONDS}s long.`
  }
  if (speed === null) return 'Choose a speed or a target duration the section can reach.'
  if (speed < SPEED_MIN || speed > SPEED_MAX) {
    return `Speed must be between ${SPEED_MIN}× and ${SPEED_MAX}× (this asks for ${roundHundredths(speed)}×).`
  }
  if (Math.abs(speed - 1) < 0.005) return '1× changes nothing. Pick another speed.'
  return null
}

export function speedChangeOutcome(
  draft: SpeedChangeDraft,
  durationSeconds: number | null,
): SpeedChangeOutcome {
  const { start, end } = sectionBounds(draft.section, durationSeconds)
  const effectiveSpeed = draft.speed
    ?? (draft.targetSeconds !== null
      ? speedFromTarget(draft.targetSeconds, start, end, durationSeconds)
      : null)
  const outputSeconds = durationSeconds !== null && end !== null && effectiveSpeed !== null && effectiveSpeed > 0
    ? durationSeconds - (end - start) + (end - start) / effectiveSpeed
    : null
  return {
    effectiveSpeed,
    sectionStartSeconds: start,
    sectionEndSeconds: end,
    outputSeconds,
    error: outcomeError(effectiveSpeed, start, end),
  }
}

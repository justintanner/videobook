import { isWatermarkPlatform, WATERMARK_PLATFORMS } from '../../server/src/watermark-platform'
import type { WatermarkPlatform } from '../../server/src/watermark-platform'
import type { WatermarkReviewPatch } from '../components/videobook/confirm/bodies/WatermarkBody'
import { isWatermarkHandlePlacement, isWatermarkPosition } from './watermark-review'

type WatermarkReviewPreferences = Omit<WatermarkReviewPatch, 'handle'> & {
  handles?: Partial<Record<WatermarkPlatform, string>>
}

const STORAGE_PREFIX = 'videobook.watermark-review.v1:'
const sessionPreferences = new Map<string, WatermarkReviewPreferences>()

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parsePreferences(value: unknown): WatermarkReviewPreferences {
  const input = record(value)
  if (!input) return {}
  const preferences: WatermarkReviewPreferences = {}
  if (isWatermarkPlatform(input.platform)) preferences.platform = input.platform
  if (isWatermarkPosition(input.position)) preferences.position = input.position
  if (isWatermarkHandlePlacement(input.handlePlacement)) preferences.handlePlacement = input.handlePlacement
  if (typeof input.url === 'string') preferences.url = input.url
  for (const key of [
    'includeQr', 'includeHandle', 'includePlatformIcon', 'includeHandleBorder', 'saveDefault',
  ] as const) {
    if (typeof input[key] === 'boolean') preferences[key] = input[key]
  }
  for (const key of [
    'handleVerticalPercent', 'handlePadding', 'handlePaddingY', 'handleRounding',
    'qrOpacity', 'handleOpacity', 'fadeSeconds', 'qrStartSeconds', 'handleStartSeconds',
  ] as const) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value)) preferences[key] = value
  }
  for (const key of ['qrEndSeconds', 'handleEndSeconds'] as const) {
    const value = input[key]
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) preferences[key] = value
  }
  const handles = record(input.handles)
  if (handles) {
    preferences.handles = {}
    for (const platform of WATERMARK_PLATFORMS) {
      if (typeof handles[platform] === 'string') preferences.handles[platform] = handles[platform]
    }
  }
  return preferences
}

export function readWatermarkReviewPreferences(bookId: string | null): WatermarkReviewPreferences {
  if (!bookId) return {}
  const session = sessionPreferences.get(bookId)
  if (session) return session
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${bookId}`)
    if (stored !== null) return parsePreferences(JSON.parse(stored))
  } catch {
    return sessionPreferences.get(bookId) ?? {}
  }
  return sessionPreferences.get(bookId) ?? {}
}

export function saveWatermarkReviewPreferences(
  bookId: string | null,
  platform: WatermarkPlatform,
  { handle, ...patch }: WatermarkReviewPatch,
): void {
  if (!bookId) return
  const previous = readWatermarkReviewPreferences(bookId)
  const preferences = {
    ...previous,
    ...parsePreferences(patch),
    platform: patch.platform ?? platform,
    handles: handle === undefined ? previous.handles : { ...previous.handles, [platform]: handle },
  }
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${bookId}`, JSON.stringify(preferences))
    sessionPreferences.delete(bookId)
  } catch {
    sessionPreferences.set(bookId, preferences)
  }
}

export function fitWatermarkReviewTiming(
  preferences: WatermarkReviewPreferences,
  duration: number | null,
): WatermarkReviewPreferences {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return preferences
  const fitted = { ...preferences }
  for (const [startKey, endKey] of [
    ['qrStartSeconds', 'qrEndSeconds'],
    ['handleStartSeconds', 'handleEndSeconds'],
  ] as const) {
    const start = Math.max(0, preferences[startKey] ?? 0)
    const end = Math.min(duration, preferences[endKey] ?? duration)
    fitted[startKey] = start < end ? start : 0
    fitted[endKey] = start < end && preferences[endKey] != null ? end : null
  }
  return fitted
}

export function resolveWatermarkReviewInputs(
  preferences: WatermarkReviewPreferences,
  initial: WatermarkReviewPatch,
  duration: number | null,
): WatermarkReviewPreferences & { platform: WatermarkPlatform } {
  const platform = initial.platform ?? preferences.platform ?? 'x'
  return {
    ...fitWatermarkReviewTiming(preferences, duration),
    ...parsePreferences(initial),
    platform,
    handles: initial.handle === undefined
      ? preferences.handles
      : { ...preferences.handles, [platform]: initial.handle },
  }
}

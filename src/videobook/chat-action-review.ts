import { formatMediaTime } from './notebook-cell-presentation'
import { scanNotebookMentions } from 'videobook-engine/notebook-mentions'

type RoutedActionSettingTone = 'default' | 'warning'

interface RoutedActionSetting {
  label: string
  value: string
  tone: RoutedActionSettingTone
  wide: boolean
}

interface RoutedActionReview {
  title: string
  settings: RoutedActionSetting[]
}

interface RoutedActionReviewInput {
  input: string
  params: Record<string, unknown>
  tool: string
}

function hasValue(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key)
    && params[key] !== undefined
    && params[key] !== null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function timestampValue(value: unknown): string | null {
  const seconds = finiteNumber(value)
  if (seconds !== null) return formatMediaTime(seconds)
  return textValue(value)
}

function sourceValue(
  input: string,
  params: Record<string, unknown>,
): string {
  const mentions = scanNotebookMentions(input).map((mention) => mention.raw)
  const source = textValue(params.asset_id)
  if (source?.startsWith('@')) return source
  if (mentions.length === 1) return mentions[0]
  if (source) return `@${source}`
  return 'Not provided'
}

function setting(
  label: string,
  value: string,
  tone: RoutedActionSettingTone = 'default',
  wide = false,
): RoutedActionSetting {
  return { label, value, tone, wide }
}

function durationValue(start: unknown, end: unknown): string | null {
  const startSeconds = finiteNumber(start)
  const endSeconds = finiteNumber(end)
  if (startSeconds === null || endSeconds === null || endSeconds < startSeconds) {
    return null
  }
  return formatMediaTime(endSeconds - startSeconds)
}

function extractReview(input: RoutedActionReviewInput): RoutedActionReview {
  const start = hasValue(input.params, 'start_time')
    ? timestampValue(input.params.start_time) ?? 'Not provided'
    : '0:00 (default)'
  const end = timestampValue(input.params.end_time) ?? 'Not provided'
  const duration = durationValue(input.params.start_time ?? 0, input.params.end_time)
    ?? 'Calculated on apply'
  return {
    title: 'Extract new video clip',
    settings: [
      setting('Source', sourceValue(input.input, input.params)),
      setting('Start', start),
      setting('End', end),
      setting('Duration', duration),
      setting('Output', 'New clip · source preserved'),
      setting('Name', textValue(input.params.name) ?? 'Automatic'),
    ],
  }
}

function splitReview(input: RoutedActionReviewInput): RoutedActionReview {
  const splitAt = timestampValue(input.params.chunk_a_end) ?? 'Not provided'
  const remainingStartValue = hasValue(input.params, 'chunk_b_start')
    ? input.params.chunk_b_start
    : input.params.chunk_a_end
  const remainingStart = timestampValue(remainingStartValue) ?? 'Not provided'
  const splitSeconds = finiteNumber(input.params.chunk_a_end)
  const remainingSeconds = finiteNumber(remainingStartValue)
  const overlap = splitSeconds !== null
    && remainingSeconds !== null
    && remainingSeconds < splitSeconds
    ? formatMediaTime(splitSeconds - remainingSeconds)
    : 'None'
  return {
    title: 'Split video into two clips',
    settings: [
      setting('Source', sourceValue(input.input, input.params)),
      setting('First clip', `0:00 → ${splitAt}`),
      setting('Remaining clip', `${remainingStart} → end`),
      setting('Overlap', overlap),
      setting('Output', 'Two new clips · source preserved'),
    ],
  }
}

function trimReview(input: RoutedActionReviewInput): RoutedActionReview {
  const cutMode = hasValue(input.params, 'cut_start')
    || hasValue(input.params, 'cut_end')
  const startKey = cutMode ? 'cut_start' : 'trim_start'
  const endKey = cutMode ? 'cut_end' : 'trim_end'
  const start = hasValue(input.params, startKey)
    ? timestampValue(input.params[startKey]) ?? 'Not provided'
    : cutMode
      ? 'Not provided'
      : '0:00 (default)'
  const end = hasValue(input.params, endKey)
    ? timestampValue(input.params[endKey]) ?? 'Not provided'
    : cutMode
      ? 'Not provided'
      : 'End of video'
  return {
    title: cutMode ? 'Remove section from video' : 'Trim video in place',
    settings: [
      setting('Source', sourceValue(input.input, input.params)),
      setting('Operation', cutMode ? 'Remove range' : 'Keep range'),
      setting('Start', start),
      setting('End', end),
      setting('Output', 'Existing source updated in place', 'warning'),
      setting('Recovery', 'Previous version retained'),
    ],
  }
}

function humanize(value: string): string {
  const spaced = value.replaceAll('_', ' ').replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

const sensitiveKeyPattern = /api.?key|secret|(?:^|[_-])token(?:$|[_-])|password|credential|authorization/iu

function identifiesSensitiveValue(
  key: string,
  params: Record<string, unknown>,
): boolean {
  if (key !== 'value') return false
  return Object.entries(params).some(([candidateKey, candidateValue]) =>
    /^(?:env_?)?key$|^(?:variable_?)?name$/iu.test(candidateKey)
    && typeof candidateValue === 'string'
    && sensitiveKeyPattern.test(candidateValue),
  )
}

function sanitizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizedValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKeyPattern.test(key) ? 'Hidden' : sanitizedValue(entry),
  ]))
}

function genericValue(
  key: string,
  value: unknown,
  params: Record<string, unknown>,
): string {
  if (sensitiveKeyPattern.test(key) || identifiesSensitiveValue(key, params)) {
    return 'Hidden'
  }
  if (/time|seconds|duration/iu.test(key)) {
    const timestamp = timestampValue(value)
    if (timestamp) return timestamp
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  if (
    typeof value === 'string'
    && (/url/iu.test(key) || /^https?:\/\//iu.test(value))
  ) return value
  if (typeof value === 'string') return value.length > 96
    ? `${value.slice(0, 93)}…`
    : value
  const serialized = JSON.stringify(sanitizedValue(value))
  if (!serialized) return 'None'
  return serialized.length > 96 ? `${serialized.slice(0, 93)}…` : serialized
}

function genericReview(input: RoutedActionReviewInput): RoutedActionReview {
  const settings = Object.entries(input.params)
    .filter(([key]) => key !== 'book_id')
    .slice(0, 8)
    .map(([key, value]) => setting(
      humanize(key),
      key === 'asset_id'
        ? sourceValue(input.input, input.params)
        : genericValue(key, value, input.params),
      'default',
      /url/iu.test(key) && typeof value === 'string',
    ))
  return {
    title: humanize(input.tool),
    settings: settings.length > 0
      ? settings
      : [setting('Tool', input.tool)],
  }
}

export function routedActionReview(
  input: RoutedActionReviewInput,
): RoutedActionReview {
  if (input.tool === 'extract_video_clip') return extractReview(input)
  if (input.tool === 'split_video') return splitReview(input)
  if (input.tool === 'trim_video') return trimReview(input)
  return genericReview(input)
}

import { formatMediaTime } from './notebook-cell-presentation'
import { scanNotebookMentions } from 'videobook-engine/notebook-mentions'

type RoutedActionSettingTone = 'default' | 'warning'

export interface RoutedActionSetting {
  label: string
  value: string
  tone: RoutedActionSettingTone
  wide: boolean
}

// What applying does to the source, shown as the sheet's effect chip.
interface RoutedActionEffect {
  label: string
  tone: RoutedActionSettingTone
}

interface RoutedActionReview {
  title: string
  settings: RoutedActionSetting[]
  effect: RoutedActionEffect | null
  postText?: string
}

const IN_PLACE_EFFECT: RoutedActionEffect = {
  label: 'In place · previous version kept',
  tone: 'warning',
}

interface RoutedActionReviewInput {
  input: string
  params: Record<string, unknown>
  tool: string
  sourceDurationSeconds?: number | null
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
    effect: { label: 'New clip · source preserved', tone: 'default' },
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
    effect: { label: 'Two new clips · source preserved', tone: 'default' },
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
    effect: IN_PLACE_EFFECT,
  }
}

function humanize(value: string): string {
  const spaced = value.replaceAll('_', ' ').replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function formatSpeedMultiplier(speed: number): string {
  return String(Number(speed.toFixed(2)))
}

function changeVideoSpeedReview(input: RoutedActionReviewInput): RoutedActionReview {
  const sourceDuration = finiteNumber(input.sourceDurationSeconds)
  const requestedSpeed = finiteNumber(input.params.speed)
  const targetDuration = finiteNumber(input.params.target_duration_seconds)
  const effectiveSpeed = requestedSpeed
    ?? (sourceDuration !== null && targetDuration !== null && targetDuration > 0
      ? sourceDuration / targetDuration
      : null)
  const expectedDuration = targetDuration
    ?? (sourceDuration !== null && effectiveSpeed !== null && effectiveSpeed > 0
      ? sourceDuration / effectiveSpeed
      : null)
  const settings = [
    setting('Source', sourceValue(input.input, input.params)),
  ]
  if (sourceDuration !== null && sourceDuration > 0) {
    settings.push(setting('Source duration', formatMediaTime(sourceDuration)))
  }
  settings.push(setting(
    'Speed',
    effectiveSpeed !== null
      ? `${formatSpeedMultiplier(effectiveSpeed)}×${requestedSpeed === null ? ' (from target duration)' : ''}`
      : 'Calculated on apply',
  ))
  if (targetDuration !== null) {
    settings.push(setting('Target duration', formatMediaTime(targetDuration)))
  }
  if (expectedDuration !== null && expectedDuration > 0 && targetDuration === null) {
    settings.push(setting('Expected duration', formatMediaTime(expectedDuration)))
  }
  settings.push(
    setting('Output', 'Existing source updated in place', 'warning'),
    setting('Recovery', 'Previous version retained'),
  )
  return {
    title: 'Change video speed',
    settings,
    effect: IN_PLACE_EFFECT,
  }
}

function postToXReview(input: RoutedActionReviewInput): RoutedActionReview {
  const scheduledFor = textValue(input.params.scheduled_for)
  const orientation = textValue(input.params.orientation)
  return {
    title: 'Post to X',
    settings: [
      setting('Destination', 'X'),
      setting('Source', sourceValue(input.input, input.params)),
      setting(
        'Publish',
        scheduledFor ? `Scheduled · ${scheduledFor}` : 'Now',
        'default',
        scheduledFor !== null,
      ),
      setting('Orientation', orientation ? humanize(orientation) : 'Keep source'),
    ],
    effect: {
      label: scheduledFor ? 'Publishes to X · scheduled' : 'Publishes to X · now',
      tone: 'default',
    },
    postText: typeof input.params.text === 'string' ? input.params.text : '',
  }
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

function chainReview(input: RoutedActionReviewInput): RoutedActionReview {
  const steps = Array.isArray(input.params.steps) ? input.params.steps : []
  const settings = steps.flatMap((entry, index) => {
    const step = recordLike(entry)
    const tool = textValue(step?.tool) ?? `step ${index + 1}`
    const params = recordLike(step?.params) ?? {}
    const target = textValue(params.asset_id)
      ?? textValue(params.audio_asset_id)
      ?? sourceValue(input.input, params)
    return [setting(`Step ${index + 1}`, `${humanize(tool)} · ${target}`)]
  })
  const mutatesInPlace = steps.some((entry) => {
    const tool = textValue(recordLike(entry)?.tool)
    return tool === 'replace_video_audio' || tool === 'trim_video'
  })
  return {
    title: 'Chained actions',
    settings: settings.length > 0 ? settings : [setting('Tool', 'chain')],
    effect: mutatesInPlace ? IN_PLACE_EFFECT : null,
  }
}

function recordLike(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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
    effect: null,
  }
}

export function routedActionReview(
  input: RoutedActionReviewInput,
): RoutedActionReview {
  if (input.tool === 'extract_video_clip') return extractReview(input)
  if (input.tool === 'split_video') return splitReview(input)
  if (input.tool === 'trim_video') return trimReview(input)
  if (input.tool === 'change_video_speed') return changeVideoSpeedReview(input)
  if (input.tool === 'post') return postToXReview(input)
  if (input.tool === 'chain') return chainReview(input)
  return genericReview(input)
}

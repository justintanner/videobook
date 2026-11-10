import { formatMediaTime } from './notebook-cell-presentation'
import { historicalAverageEstimate, lowerBoundEstimate } from './provider-payload-preview'
import { scanNotebookMentions } from 'videobook-engine/notebook-mentions'
import { speedChangeDraftFromParams, speedChangeOutcome } from './speed-change-draft'

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

function humanize(value: string): string {
  const spaced = value.replaceAll('_', ' ').replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function formatSpeedMultiplier(speed: number): string {
  return String(Number(speed.toFixed(2)))
}

function changeVideoSpeedReview(input: RoutedActionReviewInput): RoutedActionReview {
  const sourceDuration = finiteNumber(input.sourceDurationSeconds)
  const draft = speedChangeDraftFromParams(input.params)
  const outcome = speedChangeOutcome(draft, sourceDuration && sourceDuration > 0 ? sourceDuration : null)
  const settings = [
    setting('Source', sourceValue(input.input, input.params)),
  ]
  if (sourceDuration !== null && sourceDuration > 0) {
    settings.push(setting('Source duration', formatMediaTime(sourceDuration)))
  }
  if (draft.section) {
    const end = outcome.sectionEndSeconds
    settings.push(setting(
      'Section',
      `${formatMediaTime(outcome.sectionStartSeconds)} → ${end === null ? 'end' : formatMediaTime(end)}`,
    ))
  }
  settings.push(setting(
    'Speed',
    outcome.effectiveSpeed !== null
      ? `${formatSpeedMultiplier(outcome.effectiveSpeed)}×${draft.speed === null ? ' (from target duration)' : ''}`
      : 'Calculated on apply',
  ))
  if (draft.targetSeconds !== null && draft.speed === null) {
    settings.push(setting('Target duration', formatMediaTime(draft.targetSeconds)))
  } else if (outcome.outputSeconds !== null && outcome.outputSeconds > 0) {
    settings.push(setting('Expected duration', formatMediaTime(outcome.outputSeconds)))
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

export interface ChainStepReviewValue {
  stepId: string
  index: number
  total: number
  tool: string
  title: string
  address: string | null
  params: Record<string, unknown>
  estimateUsd: number | null
  estimateUnavailable: boolean
  estimateWarnings?: readonly string[]
  reason: string
}

export interface ChainRunValue {
  chainId: string
  status: string
  error: string | null
  awaitingStepId: string | null
  steps: Array<{
    id: string
    tool: string
    status: string
    error: string | null
    requiresApproval: boolean
    review: ChainStepReviewValue | null
  }>
}

function formatEstimatedCost(usd: number | null): string {
  if (usd === null) return 'Unknown'
  return usd < 0.01 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`
}

/**
 * One paused step of a chain. Unlike the combined sheet this names what the
 * single step will do and what approving it spends, because that is the only
 * thing the user is being asked to decide.
 */
export function chainStepReview(
  review: ChainStepReviewValue,
  remaining: number,
): RoutedActionReview {
  const historical = historicalAverageEstimate(review.estimateWarnings ?? [])
  const lowerBound = lowerBoundEstimate(review.estimateWarnings ?? [])
  const costLabel = review.estimateUnavailable
    ? 'Cost unknown for this model'
    : historical
      ? `Per-call average ${formatEstimatedCost(review.estimateUsd)}, not this request's price`
      : lowerBound
        ? `Spends at least ${formatEstimatedCost(review.estimateUsd)}`
        : `Spends about ${formatEstimatedCost(review.estimateUsd)}`
  const settings = [
    setting('Step', `${review.index + 1} of ${review.total}`),
    ...(review.address ? [setting('Source', review.address)] : []),
    ...Object.entries(review.params)
      .filter(([key]) => key !== 'prompt' && key !== '_provider')
      .slice(0, 5)
      .map(([key, value]) => setting(
        humanize(key),
        genericValue(key, value, review.params),
      )),
    setting(
      'Estimated cost',
      historical
        ? `Per-call average ${formatEstimatedCost(review.estimateUsd)}`
        : lowerBound
          ? `At least ${formatEstimatedCost(review.estimateUsd)}`
          : formatEstimatedCost(review.estimateUsd),
      review.estimateUnavailable || historical || lowerBound ? 'warning' : 'default',
    ),
    setting('Remaining steps', remaining > 0 ? String(remaining) : 'None'),
  ]
  return {
    title: `Step ${review.index + 1} of ${review.total} · ${review.title}`,
    settings,
    effect: {
      label: costLabel,
      tone: 'warning',
    },
    postText: typeof review.params.prompt === 'string'
      ? review.params.prompt
      : undefined,
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
  if (input.tool === 'change_video_speed') return changeVideoSpeedReview(input)
  if (input.tool === 'post') return postToXReview(input)
  if (input.tool === 'chain') return chainReview(input)
  return genericReview(input)
}

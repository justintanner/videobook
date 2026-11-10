import { lowerBoundCost } from './command-plan'
import { nonBlankStringValue, recordValue } from './value-decoders'

interface ProviderPromptLeak {
  token: string
  code: string
  message: string
}

interface ProviderUrlPlaceholder {
  path: string
  reference: string
  url: string
}

interface ProviderPayloadPreviewMentions {
  promptLeaks: ProviderPromptLeak[]
  urlPlaceholders: ProviderUrlPlaceholder[]
}

export function providerPayloadPreviewMentions(
  value: unknown,
): ProviderPayloadPreviewMentions {
  const root = recordValue(value)
  const mentions = recordValue(root?.mentions)
  const promptLeaks = Array.isArray(mentions?.prompt_leaks)
    ? mentions.prompt_leaks.flatMap((entry) => {
        const item = recordValue(entry)
        const token = nonBlankStringValue(item?.token)
        const code = nonBlankStringValue(item?.code)
        const message = nonBlankStringValue(item?.message)
        return token && code && message ? [{ token, code, message }] : []
      })
    : []
  const urlPlaceholders = Array.isArray(mentions?.url_placeholders)
    ? mentions.url_placeholders.flatMap((entry) => {
        const item = recordValue(entry)
        const path = nonBlankStringValue(item?.path)
        const reference = nonBlankStringValue(item?.reference)
        const url = nonBlankStringValue(item?.url)
        return path && reference && url ? [{ path, reference, url }] : []
      })
    : []
  return { promptLeaks, urlPlaceholders }
}

export function providerPayloadPreviewReferenceError(
  value: unknown,
): string | null {
  const leaks = providerPayloadPreviewMentions(value).promptLeaks
  if (leaks.length === 0) return null
  const details = leaks.map((leak) => leak.message).join('; ')
  return `Fix prompt references before generating: ${details}`
}

interface GenerationEstimate {
  usd: number | null
  currency: string
  warnings: string[]
  unknown: boolean
}

export function historicalAverageEstimate(warnings: readonly string[]): boolean {
  return warnings.length > 0 && warnings.every((warning) =>
    warning.includes('historical average per call'))
}

export function lowerBoundEstimate(warnings: readonly string[]): boolean {
  return warnings.length > 0 && warnings.every((warning) =>
    warning.includes('this estimate is a lower bound'))
}

const LOWER_BOUND_WARNING = /^(?:\w+ '[^']+': )?(.+?),? so this estimate is a lower bound\.?$/u

function lowerBoundReason(warning: string): string {
  const reason = LOWER_BOUND_WARNING.exec(warning)?.[1] ?? warning
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`
}

export function lowerBoundCaption(warnings: readonly string[]): string {
  return warnings.map(lowerBoundReason).join(' ')
}

export function workspaceEstimateCost(usd: number | null, warnings: readonly string[]): string {
  const lowerBound = lowerBoundEstimate(warnings)
  if (usd === null || usd <= 0 || (warnings.length > 0 && !lowerBound && !historicalAverageEstimate(warnings))) {
    return 'Cost estimate unavailable'
  }
  const amount = `$${usd.toFixed(4)}`
  return `Estimated cost: ${lowerBound ? lowerBoundCost(amount) : amount}`
}

export const PER_CALL_AVERAGE_CAPTION = 'Per-call average, not this request\'s price'

export function generationEstimateCaption(estimate: GenerationEstimate): string | null {
  if (estimate.usd === null || estimate.usd <= 0 || estimate.unknown) return null
  if (historicalAverageEstimate(estimate.warnings)) return PER_CALL_AVERAGE_CAPTION
  return lowerBoundEstimate(estimate.warnings) ? lowerBoundCaption(estimate.warnings) : null
}

export function generationEstimate(preview: unknown): GenerationEstimate {
  const estimate = recordValue(recordValue(preview)?.estimate)
  const warnings = Array.isArray(estimate?.warnings)
    ? estimate.warnings.filter((warning): warning is string =>
        typeof warning === 'string')
    : []
  const historical = historicalAverageEstimate(warnings)
  return {
    usd: typeof estimate?.usd === 'number' ? estimate.usd : null,
    currency: typeof estimate?.currency === 'string' ? estimate.currency : 'USD',
    warnings,
    unknown: !historical && warnings.some((warning) =>
      /not found|unavailable|no cost adapter|unknown/iu.test(warning)),
  }
}

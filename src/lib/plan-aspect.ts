export type PlanSwapModel = 'nano-banana-pro' | 'gpt-image-2' | 'wan-2-7-image-pro'

export type SeedanceAspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '21:9' | 'adaptive'
export type FalWanImageSize = 'square' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9'

export interface SourceAspect {
  width: number | null
  height: number | null
  ratio: number
  css: string
  hasMetadata: boolean
}

const FALLBACK_ASPECT_RATIO = '16:9'
const FALLBACK_RATIO = 16 / 9
const FALLBACK_CSS = '16 / 9'
const FALLBACK_FAL_WAN_IMAGE_SIZE: FalWanImageSize = 'landscape_16_9'
const SOURCE_RATIO_NATIVE_TOLERANCE = Math.log(1.025)

const SEEDANCE_NATIVE_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'] as const

const GROK_NATIVE_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '3:2', '2:3'] as const

export type GrokAspectRatio = (typeof GROK_NATIVE_ASPECT_RATIOS)[number]

const KIE_IMAGE_ASPECT_RATIOS_BY_MODEL = {
  'nano-banana-pro': ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  'gpt-image-2': ['1:1', '9:16', '16:9', '4:3', '3:4'],
  'wan-2-7-image-pro': ['1:1', '16:9', '4:3', '21:9', '3:4', '9:16', '8:1', '1:8'],
} as const

const FAL_WAN_IMAGE_SIZE_RATIOS: Record<FalWanImageSize, number> = {
  square: 1,
  portrait_4_3: 3 / 4,
  portrait_16_9: 9 / 16,
  landscape_4_3: 4 / 3,
  landscape_16_9: 16 / 9,
}

function numericDimension(value: number | null | undefined): number | null {
  if (typeof value !== 'number') return null
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

function sourceRatio(width: number | null | undefined, height: number | null | undefined): number | null {
  const w = numericDimension(width)
  const h = numericDimension(height)
  return w !== null && h !== null ? w / h : null
}

function aspectRatioValue(value: string): number {
  const [w, h] = value.split(':').map(Number)
  return w / h
}

function distance(a: number, b: number): number {
  return Math.abs(Math.log(a / b))
}

function nearestAspectRatio<T extends string>(ratio: number, options: readonly T[]): T {
  let best = options[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const option of options) {
    const d = distance(ratio, aspectRatioValue(option))
    if (d < bestDistance) {
      best = option
      bestDistance = d
    }
  }
  return best
}

function nearestFalWanImageSize(ratio: number): FalWanImageSize {
  let best: FalWanImageSize = FALLBACK_FAL_WAN_IMAGE_SIZE
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [size, sizeRatio] of Object.entries(FAL_WAN_IMAGE_SIZE_RATIOS) as Array<[FalWanImageSize, number]>) {
    const d = distance(ratio, sizeRatio)
    if (d < bestDistance) {
      best = size
      bestDistance = d
    }
  }
  return best
}

export function sourceAspectFromDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): SourceAspect {
  const w = numericDimension(width)
  const h = numericDimension(height)
  if (w === null || h === null) {
    return {
      width: null,
      height: null,
      ratio: FALLBACK_RATIO,
      css: FALLBACK_CSS,
      hasMetadata: false,
    }
  }
  return {
    width: w,
    height: h,
    ratio: w / h,
    css: `${w} / ${h}`,
    hasMetadata: true,
  }
}

export function seedanceAspectRatioForDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): SeedanceAspectRatio {
  const ratio = sourceRatio(width, height)
  if (ratio === null) return FALLBACK_ASPECT_RATIO
  const nearest = nearestAspectRatio(ratio, SEEDANCE_NATIVE_ASPECT_RATIOS)
  return distance(ratio, aspectRatioValue(nearest)) <= SOURCE_RATIO_NATIVE_TOLERANCE ? nearest : 'adaptive'
}

// Grok Imagine i2v has no 'adaptive' option, so always snap the source ratio to
// the nearest supported enum value (falling back to 16:9 when dimensions are
// unknown).
export function grokAspectRatioForDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): GrokAspectRatio {
  const ratio = sourceRatio(width, height)
  if (ratio === null) return FALLBACK_ASPECT_RATIO
  return nearestAspectRatio(ratio, GROK_NATIVE_ASPECT_RATIOS)
}

export function kieImageAspectRatioForDimensions(
  model: PlanSwapModel,
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  const ratio = sourceRatio(width, height)
  if (ratio === null) return FALLBACK_ASPECT_RATIO
  return nearestAspectRatio(ratio, KIE_IMAGE_ASPECT_RATIOS_BY_MODEL[model])
}

export function falWanImageSizeForDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): FalWanImageSize {
  const ratio = sourceRatio(width, height)
  if (ratio === null) return FALLBACK_FAL_WAN_IMAGE_SIZE
  return nearestFalWanImageSize(ratio)
}

export interface SlotBox {
  width: number
  height: number
}

// Pixel size for a plan source-input thumbnail. The slot is at most `maxW` wide;
// a tall (portrait) clip would otherwise tower over the row, so when the
// aspect-driven height exceeds `maxH` we clamp the height and derive the width —
// portrait clips render short-and-narrow instead of full-width-and-tall.
// `ratio` is width/height; a non-positive ratio falls back to 16:9.
export function sourceSlotBox(ratio: number, maxW: number, maxH: number): SlotBox {
  const r = ratio > 0 && Number.isFinite(ratio) ? ratio : FALLBACK_RATIO
  let width = maxW
  let height = maxW / r
  if (height > maxH) {
    height = maxH
    width = maxH * r
  }
  return { width: Math.round(width), height: Math.round(height) }
}

export type VideoCropRatio = '16:9' | '9:16' | '1:1'

export type VideoCropBox = { x: number; y: number; w: number; h: number }

export type VideoCropSelection = VideoCropBox & { ratio: VideoCropRatio }

export type CropCorner = 'nw' | 'ne' | 'sw' | 'se'

export type CropPoint = { x: number; y: number }

export type CropSource = { width: number; height: number }

export const VIDEO_CROP_RATIOS: readonly VideoCropRatio[] = ['16:9', '9:16', '1:1']

export const CROP_CORNERS: readonly CropCorner[] = ['nw', 'ne', 'sw', 'se']

export const CROP_OUTPUT_SIZE: Record<VideoCropRatio, string> = {
  '16:9': '1920×1080',
  '9:16': '1080×1920',
  '1:1': '1080×1080',
}

const RATIO_VALUE: Record<VideoCropRatio, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

const CORNER_DIRECTION: Record<CropCorner, { x: 1 | -1; y: 1 | -1 }> = {
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  sw: { x: -1, y: 1 },
  se: { x: 1, y: 1 },
}

const ARROW_DIRECTION: Readonly<Record<string, CropPoint>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

const KEY_SCALE: Readonly<Record<string, number>> = { '+': 1.1, '=': 1.1, '-': 1 / 1.1, _: 1 / 1.1 }

const KEY_STEP = 0.01

const KEY_STEP_LARGE = 0.1

const MIN_SIDE = 0.05

const MIN_SIDE_PIXELS = 128

const FALLBACK_SOURCE: CropSource = { width: 1920, height: 1080 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function aspectOf(source: CropSource): number {
  return source.width / source.height
}

function widthForHeight(height: number, ratio: VideoCropRatio, source: CropSource): number {
  return RATIO_VALUE[ratio] * height / aspectOf(source)
}

function largestHeight(ratio: VideoCropRatio, source: CropSource): number {
  return Math.min(1, aspectOf(source) / RATIO_VALUE[ratio])
}

function smallestHeight(ratio: VideoCropRatio, source: CropSource): number {
  const target = RATIO_VALUE[ratio]
  const shortestSide = Math.max(
    MIN_SIDE,
    MIN_SIDE * aspectOf(source) / target,
    MIN_SIDE_PIXELS / source.height,
    MIN_SIDE_PIXELS / (target * source.height),
  )
  return Math.min(largestHeight(ratio, source), shortestSide)
}

function placeCropBox(width: number, height: number, center: CropPoint): VideoCropBox {
  return {
    x: clamp(center.x - width / 2, 0, 1 - width),
    y: clamp(center.y - height / 2, 0, 1 - height),
    w: width,
    h: height,
  }
}

function scaleCropBox(
  box: VideoCropBox,
  factor: number,
  ratio: VideoCropRatio,
  source: CropSource,
): VideoCropBox {
  const height = clamp(box.h * factor, smallestHeight(ratio, source), largestHeight(ratio, source))
  return placeCropBox(widthForHeight(height, ratio, source), height, cropBoxCenter(box))
}

export function cropSource(width: number | null | undefined, height: number | null | undefined): CropSource {
  return width && height && width > 0 && height > 0 ? { width, height } : FALLBACK_SOURCE
}

export function defaultCropRatio(source: CropSource): VideoCropRatio {
  return aspectOf(source) >= 1 ? '9:16' : '1:1'
}

export function cropBoxCenter(box: VideoCropBox): CropPoint {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

export function largestCropBox(
  ratio: VideoCropRatio,
  source: CropSource,
  center: CropPoint = { x: 0.5, y: 0.5 },
): VideoCropBox {
  const height = largestHeight(ratio, source)
  return placeCropBox(widthForHeight(height, ratio, source), height, center)
}

export function moveCropBox(box: VideoCropBox, dx: number, dy: number): VideoCropBox {
  return { ...box, x: clamp(box.x + dx, 0, 1 - box.w), y: clamp(box.y + dy, 0, 1 - box.h) }
}

export function resizeCropBox(
  box: VideoCropBox,
  corner: CropCorner,
  pointer: CropPoint,
  ratio: VideoCropRatio,
  source: CropSource,
): VideoCropBox {
  const direction = CORNER_DIRECTION[corner]
  const target = RATIO_VALUE[ratio]
  const aspect = aspectOf(source)
  const anchor = {
    x: direction.x > 0 ? box.x : box.x + box.w,
    y: direction.y > 0 ? box.y : box.y + box.h,
  }
  const reachWidth = (pointer.x - anchor.x) * direction.x * aspect
  const reachHeight = (pointer.y - anchor.y) * direction.y
  const projected = (reachWidth * target + reachHeight) / (target * target + 1)
  const roomWidth = (direction.x > 0 ? 1 - anchor.x : anchor.x) * aspect
  const roomHeight = direction.y > 0 ? 1 - anchor.y : anchor.y
  const height = clamp(projected, smallestHeight(ratio, source), Math.min(roomHeight, roomWidth / target))
  const width = widthForHeight(height, ratio, source)
  return {
    x: direction.x > 0 ? anchor.x : anchor.x - width,
    y: direction.y > 0 ? anchor.y : anchor.y - height,
    w: width,
    h: height,
  }
}

export function cropBoxForKey(
  box: VideoCropBox,
  key: string,
  large: boolean,
  ratio: VideoCropRatio,
  source: CropSource,
): VideoCropBox | null {
  const arrow = ARROW_DIRECTION[key]
  if (arrow) {
    const step = large ? KEY_STEP_LARGE : KEY_STEP
    return moveCropBox(box, arrow.x * step, arrow.y * step)
  }
  const factor = KEY_SCALE[key]
  return factor ? scaleCropBox(box, factor, ratio, source) : null
}

export function cropBoxPixels(box: VideoCropBox, source: CropSource): VideoCropBox {
  return {
    x: Math.round(box.x * source.width),
    y: Math.round(box.y * source.height),
    w: Math.round(box.w * source.width),
    h: Math.round(box.h * source.height),
  }
}

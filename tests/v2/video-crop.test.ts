import { describe, expect, it } from 'vitest'
import { cropGeometry } from '../../server/src/crop-geometry.js'
import {
  CROP_CORNERS,
  VIDEO_CROP_RATIOS,
  cropBoxCenter,
  cropBoxForKey,
  cropBoxPixels,
  defaultCropRatio,
  largestCropBox,
  moveCropBox,
  cropSource,
  resizeCropBox,
} from '../../src/videobook/video-crop'
import type { CropSource, VideoCropBox, VideoCropRatio } from '../../src/videobook/video-crop'

const LANDSCAPE: CropSource = { width: 1920, height: 1080 }
const PORTRAIT: CropSource = { width: 1080, height: 1920 }
const RATIO: Record<VideoCropRatio, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

function pixelAspect(box: VideoCropBox, source: CropSource): number {
  return box.w * source.width / (box.h * source.height)
}

function expectInsideFrame(box: VideoCropBox): void {
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.w).toBeLessThanOrEqual(1 + 1e-9)
  expect(box.y + box.h).toBeLessThanOrEqual(1 + 1e-9)
}

describe('video crop geometry', () => {
  it('starts with the largest centred box of the ratio', () => {
    const portrait = largestCropBox('9:16', LANDSCAPE)
    expect(portrait.h).toBe(1)
    expect(portrait.w).toBeCloseTo(0.31640625, 8)
    expect(portrait.x).toBeCloseTo((1 - portrait.w) / 2, 8)
    expect(largestCropBox('16:9', LANDSCAPE)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const square = largestCropBox('1:1', PORTRAIT)
    expect(square.w).toBe(1)
    expect(square.h).toBeCloseTo(0.5625, 8)
  })

  it('keeps a ratio switch near the old centre without leaving the frame', () => {
    const box = largestCropBox('9:16', LANDSCAPE, { x: 0.97, y: 0.5 })
    expect(box.x + box.w).toBeCloseTo(1, 8)
    const square = largestCropBox('1:1', LANDSCAPE, cropBoxCenter(box))
    expectInsideFrame(square)
    expect(square.x + square.w).toBeCloseTo(1, 8)
  })

  it('moves the box but stops it at the frame edges', () => {
    const box = { x: 0.3, y: 0.2, w: 0.4, h: 0.5 }
    expect(moveCropBox(box, 0.1, -0.1)).toEqual({ x: 0.4, y: 0.1, w: 0.4, h: 0.5 })
    expect(moveCropBox(box, 2, 2)).toEqual({ x: 0.6, y: 0.5, w: 0.4, h: 0.5 })
    expect(moveCropBox(box, -2, -2)).toEqual({ x: 0, y: 0, w: 0.4, h: 0.5 })
  })

  it('resizes from a corner while the opposite corner stays put and the ratio holds', () => {
    const start = { x: 0.2, y: 0.2, w: 0.5625 * 0.4 * 1080 / 1920, h: 0.4 }
    const grown = resizeCropBox(start, 'se', { x: 0.6, y: start.y + start.h }, '9:16', LANDSCAPE)
    expect(grown.x).toBeCloseTo(start.x, 10)
    expect(grown.y).toBeCloseTo(start.y, 10)
    expect(grown.h).toBeGreaterThan(start.h)
    expect(pixelAspect(grown, LANDSCAPE)).toBeCloseTo(9 / 16, 10)

    const shrunk = resizeCropBox(start, 'nw', { x: start.x + start.w / 2, y: start.y + start.h / 2 }, '9:16', LANDSCAPE)
    expect(shrunk.x + shrunk.w).toBeCloseTo(start.x + start.w, 10)
    expect(shrunk.y + shrunk.h).toBeCloseTo(start.y + start.h, 10)
    expect(shrunk.h).toBeLessThan(start.h)
  })

  it('stops a corner drag at the frame and at the smallest box', () => {
    for (const ratio of VIDEO_CROP_RATIOS) {
      const start = largestCropBox(ratio, LANDSCAPE)
      const half = { ...start, w: start.w / 2, h: start.h / 2, x: start.x + start.w / 4, y: start.y + start.h / 4 }
      for (const corner of CROP_CORNERS) {
        const outward = resizeCropBox(half, corner, { x: corner.endsWith('e') ? 5 : -5, y: corner.startsWith('s') ? 5 : -5 }, ratio, LANDSCAPE)
        expectInsideFrame(outward)
        expect(pixelAspect(outward, LANDSCAPE)).toBeCloseTo(RATIO[ratio], 8)
        const inward = resizeCropBox(half, corner, cropBoxCenter(half), ratio, LANDSCAPE)
        const crossed = resizeCropBox(half, corner, { x: corner.endsWith('e') ? -5 : 5, y: corner.startsWith('s') ? -5 : 5 }, ratio, LANDSCAPE)
        expect(Math.min(crossed.w * LANDSCAPE.width, crossed.h * LANDSCAPE.height)).toBeGreaterThanOrEqual(128 - 1e-6)
        expect(Math.min(crossed.w, crossed.h)).toBeGreaterThanOrEqual(0.05 - 1e-9)
        expect(crossed.h).toBeLessThanOrEqual(inward.h + 1e-9)
        expectInsideFrame(crossed)
      }
    }
  })

  it('moves with arrow keys, jumps with Shift and resizes with plus and minus', () => {
    const box = largestCropBox('9:16', LANDSCAPE)
    expect(cropBoxForKey(box, 'ArrowRight', false, '9:16', LANDSCAPE)?.x).toBeCloseTo(box.x + 0.01, 10)
    expect(cropBoxForKey(box, 'ArrowLeft', true, '9:16', LANDSCAPE)?.x).toBeCloseTo(box.x - 0.1, 10)
    expect(cropBoxForKey(box, 'ArrowDown', false, '9:16', LANDSCAPE)).toEqual(box)
    const smaller = cropBoxForKey(box, '-', false, '9:16', LANDSCAPE)!
    expect(smaller.h).toBeCloseTo(1 / 1.1, 10)
    expect(cropBoxCenter(smaller).x).toBeCloseTo(cropBoxCenter(box).x, 10)
    expect(pixelAspect(smaller, LANDSCAPE)).toBeCloseTo(9 / 16, 10)
    expect(cropBoxForKey(smaller, '+', false, '9:16', LANDSCAPE)?.h).toBeCloseTo(1, 10)
    expect(cropBoxForKey(box, '=', false, '9:16', LANDSCAPE)?.h).toBe(1)
    expect(cropBoxForKey(box, 'a', false, '9:16', LANDSCAPE)).toBeNull()
  })

  it('picks a default ratio that changes the shape of the source', () => {
    expect(defaultCropRatio(LANDSCAPE)).toBe('9:16')
    expect(defaultCropRatio({ width: 1080, height: 1080 })).toBe('9:16')
    expect(defaultCropRatio(PORTRAIT)).toBe('1:1')
    expect(cropSource(1080, 1920)).toEqual(PORTRAIT)
    expect(cropSource(null, 1080)).toEqual(LANDSCAPE)
    expect(cropSource(0, 0)).toEqual(LANDSCAPE)
  })

  it('never shrinks a box below 128 source pixels on either side', () => {
    const tiny = { width: 320, height: 180 }
    let box = largestCropBox('16:9', tiny)
    for (let step = 0; step < 60; step += 1) box = cropBoxForKey(box, '-', false, '16:9', tiny)!
    expect(cropBoxPixels(box, tiny)).toMatchObject({ w: 228, h: 128 })
    expect(largestCropBox('9:16', tiny)).toEqual(cropBoxForKey(largestCropBox('9:16', tiny), '-', false, '9:16', tiny))
  })

  it('reports the source pixels the box covers', () => {
    expect(cropBoxPixels(largestCropBox('9:16', LANDSCAPE), LANDSCAPE)).toEqual({ x: 656, y: 0, w: 608, h: 1080 })
  })

  it('only produces boxes the server crop accepts', () => {
    const sources: Array<[number, number]> = [[320, 180], [1920, 1080], [1080, 1920], [3840, 2160], [640, 480]]
    for (const [width, height] of sources) {
      const source = { width, height }
      for (const ratio of VIDEO_CROP_RATIOS) {
        const largest = largestCropBox(ratio, source)
        let small = largest
        for (let step = 0; step < 60; step += 1) small = cropBoxForKey(small, '-', false, ratio, source)!
        const crossed = resizeCropBox(small, 'se', { x: -1, y: -1 }, ratio, source)
        const dragged = resizeCropBox(moveCropBox(small, 0.3, 0.3), 'nw', { x: 0.1, y: 0.15 }, ratio, source)
        for (const box of [largest, small, crossed, dragged]) {
          expect(() => cropGeometry(box, width, height, ratio, 2)).not.toThrow()
        }
      }
    }
  })
})

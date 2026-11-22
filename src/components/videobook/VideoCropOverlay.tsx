import { Check, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import {
  CROP_CORNERS,
  CROP_OUTPUT_SIZE,
  VIDEO_CROP_RATIOS,
  cropBoxCenter,
  cropBoxForKey,
  cropBoxPixels,
  cropSource,
  defaultCropRatio,
  largestCropBox,
  moveCropBox,
  resizeCropBox,
} from '@/videobook/video-crop'
import type {
  CropCorner,
  CropPoint,
  CropSource,
  VideoCropBox,
  VideoCropRatio,
  VideoCropSelection,
} from '@/videobook/video-crop'

type VideoFrame = {
  left: number
  top: number
  width: number
  height: number
  source: CropSource
}

type CropDrag =
  | { kind: 'move'; pointerId: number; origin: CropPoint; box: VideoCropBox }
  | { kind: 'resize'; pointerId: number; corner: CropCorner }

type VideoCropOverlayProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  sourceWidth: number | null
  sourceHeight: number | null
  pending: boolean
  onApply: (selection: VideoCropSelection) => void
  onCancel: () => void
}

function containedVideoFrame(
  video: HTMLVideoElement,
  fallbackWidth: number | null,
  fallbackHeight: number | null,
): VideoFrame | null {
  const boxWidth = video.clientWidth
  const boxHeight = video.clientHeight
  if (boxWidth <= 0 || boxHeight <= 0) return null
  const sourceWidth = video.videoWidth || fallbackWidth || boxWidth
  const sourceHeight = video.videoHeight || fallbackHeight || boxHeight
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    left: video.offsetLeft + (boxWidth - width) / 2,
    top: video.offsetTop + (boxHeight - height) / 2,
    width,
    height,
    source: { width: sourceWidth, height: sourceHeight },
  }
}

function useContainedVideoFrame(
  videoRef: RefObject<HTMLVideoElement | null>,
  fallbackWidth: number | null,
  fallbackHeight: number | null,
): VideoFrame | null {
  const [frame, setFrame] = useState<VideoFrame | null>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const measure = () => setFrame(containedVideoFrame(video, fallbackWidth, fallbackHeight))
    const observer = new ResizeObserver(measure)
    observer.observe(video)
    video.addEventListener('loadedmetadata', measure)
    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', measure)
    }
  }, [videoRef, fallbackWidth, fallbackHeight])
  return frame
}

function frameStyle(frame: VideoFrame | null): CSSProperties | undefined {
  return frame
    ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
    : undefined
}

function boxStyle(box: VideoCropBox): CSSProperties {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  }
}

function cropBox(selection: VideoCropSelection): VideoCropBox {
  return { x: selection.x, y: selection.y, w: selection.w, h: selection.h }
}

export function VideoCropOverlay({
  videoRef,
  sourceWidth,
  sourceHeight,
  pending,
  onApply,
  onCancel,
}: VideoCropOverlayProps) {
  const hintId = useId()
  const frameRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<CropDrag | null>(null)
  const frame = useContainedVideoFrame(videoRef, sourceWidth, sourceHeight)
  const [chosen, setChosen] = useState<VideoCropSelection | null>(null)
  const source = frame?.source ?? cropSource(sourceWidth, sourceHeight)
  const initialRatio = defaultCropRatio(source)
  const selection = chosen ?? { ratio: initialRatio, ...largestCropBox(initialRatio, source) }
  const pixels = cropBoxPixels(selection, source)

  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true })
  }, [])

  const update = (box: VideoCropBox) => setChosen({ ratio: selection.ratio, ...box })

  const chooseRatio = (ratio: VideoCropRatio) => {
    setChosen({ ratio, ...largestCropBox(ratio, source, cropBoxCenter(selection)) })
  }

  const pointerPoint = (event: ReactPointerEvent): CropPoint | null => {
    const bounds = frameRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    }
  }

  const startDrag = (event: ReactPointerEvent<HTMLElement>, next: (point: CropPoint) => CropDrag) => {
    if (pending || event.button !== 0) return
    const point = pointerPoint(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    boxRef.current?.focus({ preventScroll: true })
    drag.current = next(point)
  }

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    startDrag(event, (origin) => ({ kind: 'move', pointerId: event.pointerId, origin, box: cropBox(selection) }))
  }

  const startResize = (event: ReactPointerEvent<HTMLElement>, corner: CropCorner) => {
    startDrag(event, () => ({ kind: 'resize', pointerId: event.pointerId, corner }))
  }

  const continueDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const point = pointerPoint(event)
    if (!point) return
    update(current.kind === 'move'
      ? moveCropBox(current.box, point.x - current.origin.x, point.y - current.origin.y)
      : resizeCropBox(cropBox(selection), current.corner, point, selection.ratio, source))
  }

  const endDrag = () => {
    drag.current = null
  }

  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (pending || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onApply(selection)
      return
    }
    const next = cropBoxForKey(cropBox(selection), event.key, event.shiftKey, selection.ratio, source)
    if (!next) return
    event.preventDefault()
    update(next)
  }

  return (
    <div className="video-crop-overlay">
      <div
        ref={frameRef}
        className="video-crop-frame"
        style={frameStyle(frame)}
        onPointerMove={continueDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          ref={boxRef}
          className="video-crop-box"
          style={boxStyle(selection)}
          role="group"
          tabIndex={0}
          aria-label={`Crop area, ${selection.ratio}`}
          aria-describedby={hintId}
          aria-disabled={pending}
          onPointerDown={startMove}
          onKeyDown={handleKey}
        >
          {CROP_CORNERS.map((corner) => (
            <span
              key={corner}
              className={`video-crop-handle ${corner}`}
              data-corner={corner}
              aria-hidden="true"
              onPointerDown={(event) => startResize(event, corner)}
            />
          ))}
        </div>
      </div>
      <div className="video-crop-toolbar">
        <p id={hintId} className="video-crop-hint">
          Drag to move, drag a corner to resize. Arrow keys move, + and − resize, Enter crops.
        </p>
        <div className="video-crop-controls">
          <div className="video-crop-ratios" role="group" aria-label="Crop aspect ratio">
            {VIDEO_CROP_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                aria-pressed={ratio === selection.ratio}
                disabled={pending}
                onClick={() => chooseRatio(ratio)}
              >
                {ratio}
              </button>
            ))}
          </div>
          <span className="video-crop-size">
            {pixels.w}×{pixels.h} → {CROP_OUTPUT_SIZE[selection.ratio]}
          </span>
          <button type="button" className="video-crop-cancel" disabled={pending} onClick={onCancel}>
            <X size={16} />
            Cancel
          </button>
          <button
            type="button"
            className="video-crop-apply"
            disabled={pending}
            onClick={() => onApply(selection)}
          >
            {pending ? <BusyIndicator size={16} /> : <Check size={16} />}
            {pending ? 'Cropping…' : `Crop to ${selection.ratio}`}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef } from 'react'

const TILE_HEIGHT = 64
const SEEK_TIMEOUT_MS = 4000

function waitForEvent(video: HTMLVideoElement, eventName: 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error(`${eventName} timed out`)), SEEK_TIMEOUT_MS)
    const onDone = () => finish(null)
    const onError = () => finish(new Error('video failed to load'))
    function finish(error: Error | null) {
      window.clearTimeout(timer)
      video.removeEventListener(eventName, onDone)
      video.removeEventListener('error', onError)
      if (error) reject(error)
      else resolve()
    }
    video.addEventListener(eventName, onDone)
    video.addEventListener('error', onError)
  })
}

function drawCover(context: CanvasRenderingContext2D, video: HTMLVideoElement, x: number, width: number, height: number) {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const cropWidth = width / scale
  const cropHeight = height / scale
  context.drawImage(video, (sourceWidth - cropWidth) / 2, (sourceHeight - cropHeight) / 2, cropWidth, cropHeight, x, 0, width, height)
}

async function drawFilmstrip(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  durationSeconds: number,
  portrait: boolean,
  isCancelled: () => boolean,
) {
  const count = portrait ? 24 : 12
  const tileWidth = Math.round(TILE_HEIGHT * (portrait ? 0.75 : 1.5))
  canvas.width = tileWidth * count
  canvas.height = TILE_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) return
  if (video.readyState < 2) await waitForEvent(video, 'loadeddata')
  for (let index = 0; index < count; index += 1) {
    if (isCancelled()) return
    const seconds = Math.min(Math.max(0, durationSeconds - 0.05), ((index + 0.5) / count) * durationSeconds)
    const seeked = waitForEvent(video, 'seeked')
    video.currentTime = seconds
    await seeked
    if (isCancelled()) return
    drawCover(context, video, index * tileWidth, tileWidth, TILE_HEIGHT)
  }
}

/* Frames from across the clip, drawn once into a canvas that the source lane
   stretches to its width, so time runs left to right at the lane's scale. */
export function AutoEditFilmstrip({
  mediaUrl,
  durationSeconds,
  portrait,
}: {
  mediaUrl: string
  durationSeconds: number
  portrait: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || durationSeconds <= 0) return
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true
    video.src = mediaUrl
    void drawFilmstrip(canvas, video, durationSeconds, portrait, () => cancelled).catch(() => undefined)
    return () => {
      cancelled = true
      video.removeAttribute('src')
      video.load()
    }
  }, [durationSeconds, mediaUrl, portrait])

  return <canvas ref={canvasRef} className="auto-edit-filmstrip" aria-hidden="true" />
}

import { useEffect, useState } from 'react'

const CAPTURE_HEIGHT = 240
const SEEK_TIMEOUT_MS = 4000

export function frameCaptureKey(seconds: number): string {
  return seconds.toFixed(3)
}

function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      video.removeEventListener('seeked', done)
      reject(new Error('Frame seek timed out'))
    }, SEEK_TIMEOUT_MS)
    const done = () => {
      window.clearTimeout(timer)
      video.removeEventListener('seeked', done)
      resolve()
    }
    video.addEventListener('seeked', done)
    video.currentTime = seconds
  })
}

const METADATA_TIMEOUT_MS = 10_000
const LOAD_ATTEMPTS = 3

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Video frames did not load')), METADATA_TIMEOUT_MS)
    video.addEventListener('loadedmetadata', () => {
      window.clearTimeout(timer)
      resolve()
    }, { once: true })
    video.addEventListener('error', () => {
      window.clearTimeout(timer)
      reject(new Error('Video failed to load'))
    }, { once: true })
  })
}

function drawFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string {
  const aspect = video.videoWidth > 0 ? video.videoWidth / video.videoHeight : 9 / 16
  canvas.height = CAPTURE_HEIGHT
  canvas.width = Math.round(CAPTURE_HEIGHT * aspect)
  canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.8)
}

async function captureFramesWithRetry(input: Parameters<typeof captureFrames>[0]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await captureFrames(input)
      return
    } catch (cause) {
      if (attempt >= LOAD_ATTEMPTS || input.isCancelled()) throw cause
    }
  }
}

async function captureFrames(input: {
  captured: Set<string>
  isCancelled: () => boolean
  mediaUrl: string
  onFrame: (key: string, dataUrl: string) => void
  sampleOffset: number
  times: readonly number[]
}): Promise<void> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.src = input.mediaUrl
  video.load()
  const canvas = document.createElement('canvas')
  try {
    await waitForMetadata(video)
    for (const seconds of input.times) {
      if (input.isCancelled()) return
      const key = frameCaptureKey(seconds)
      if (input.captured.has(key)) continue
      const target = Math.min(Math.max(0, seconds + input.sampleOffset), Math.max(0, video.duration - 0.001))
      await seekTo(video, target)
      if (input.isCancelled()) return
      input.captured.add(key)
      input.onFrame(key, drawFrame(video, canvas))
    }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

// Captures still frames from a same-origin video by seeking a detached
// <video> element. Captured frames stay cached per media URL so nudging a cut
// only fetches the frames it has not seen yet.
type FrameCaptureState = {
  captured: Set<string>
  error: string | null
  frames: ReadonlyMap<string, string>
  mediaUrl: string
}

function emptyCaptureState(mediaUrl: string): FrameCaptureState {
  return { captured: new Set(), error: null, frames: new Map(), mediaUrl }
}

export function useFrameCaptures(input: {
  mediaUrl: string
  times: readonly number[]
  frameStep: number
}): { frames: ReadonlyMap<string, string>; error: string | null } {
  const [state, setState] = useState<FrameCaptureState>(() => emptyCaptureState(input.mediaUrl))
  if (state.mediaUrl !== input.mediaUrl) setState(emptyCaptureState(input.mediaUrl))
  const captured = state.captured
  const timesKey = input.times.map(frameCaptureKey).join(',')

  useEffect(() => {
    let cancelled = false
    const times = timesKey ? timesKey.split(',').map(Number) : []
    captureFramesWithRetry({
      captured,
      isCancelled: () => cancelled,
      mediaUrl: input.mediaUrl,
      onFrame: (key, dataUrl) => setState((current) => current.captured === captured
        ? { ...current, frames: new Map(current.frames).set(key, dataUrl) }
        : current),
      sampleOffset: input.frameStep / 2,
      times,
    }).catch((cause: unknown) => {
      if (cancelled) return
      setState((current) => ({ ...current, error: cause instanceof Error ? cause.message : String(cause) }))
    })
    return () => {
      cancelled = true
    }
  }, [captured, input.mediaUrl, input.frameStep, timesKey])

  return { frames: state.frames, error: state.error }
}

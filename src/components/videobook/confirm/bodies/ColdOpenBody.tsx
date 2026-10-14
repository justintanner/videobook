import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ColdOpenReview } from '@/videobook/cold-open-review'
import { coldOpenRangeError } from '../../../../../server/src/cold-open-model'
import './ColdOpenBody.css'

export function ColdOpenBody({ review, onChange, disabled }: {
  review: ColdOpenReview
  onChange: (start: number, end: number) => void
  disabled: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const phase = useRef<'hook' | 'full' | null>(null)
  const includeFull = useRef(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const selection = review.suggestion
  const start = selection?.startSeconds ?? 0
  const end = selection?.endSeconds ?? 0
  const fps = selection?.fps ?? 30
  const invalid = selection ? coldOpenRangeError(start, end, selection.durationSeconds) : null

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    phase.current = null
    let callbackId = 0
    const tick = () => {
      if (!video.seeking && phase.current === 'hook' && video.currentTime >= end - 0.5 / fps) {
        if (includeFull.current) {
          phase.current = 'full'
          video.currentTime = 0
          void video.play().catch(() => setPlaybackError('Press Play to resume the preview.'))
        } else {
          phase.current = null
          video.pause()
        }
      }
      callbackId = requestAnimationFrame(tick)
    }
    callbackId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(callbackId)
      video.pause()
    }
  }, [review.mediaUrl, start, end, fps])

  const play = async (full: boolean) => {
    const video = videoRef.current
    if (!video) return
    setPlaybackError(null)
    includeFull.current = full
    phase.current = 'hook'
    video.currentTime = start
    try { await video.play() } catch { setPlaybackError('Unable to play this preview. Try Play again.') }
  }
  const nudge = (event: KeyboardEvent<HTMLInputElement>, boundary: 'start' | 'end') => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : 1 / fps)
    onChange(boundary === 'start' ? start + delta : start, boundary === 'end' ? end + delta : end)
  }

  return (
    <div className="cold-open-review-body">
      <video ref={videoRef} src={review.mediaUrl} aria-label="Cold-open preview" controls playsInline preload="metadata" onEnded={() => {
        if (phase.current === 'hook' && includeFull.current && videoRef.current) {
          phase.current = 'full'
          videoRef.current.currentTime = 0
          void videoRef.current.play().catch(() => setPlaybackError('Press Play to resume the preview.'))
        } else phase.current = null
      }} />
      <div className="cold-open-controls">
        {!selection ? <p>AI will suggest a 2–5 second highlight. Review its timing before creating the copy. Analysis uses your configured provider and may incur charges.</p> : <>
          <p>{selection.reason}</p>
          <div className="cold-open-bounds">
            <label>Start (seconds)<input type="number" aria-label="Highlight start" step={1 / fps} min={0} max={selection.durationSeconds} value={Number.isFinite(start) ? start : ''} disabled={disabled} onKeyDown={event => nudge(event, 'start')} onChange={event => onChange(event.target.valueAsNumber, end)} /></label>
            <label>End (seconds)<input type="number" aria-label="Highlight end" step={1 / fps} min={0} max={selection.durationSeconds} value={Number.isFinite(end) ? end : ''} disabled={disabled} onKeyDown={event => nudge(event, 'end')} onChange={event => onChange(start, event.target.valueAsNumber)} /></label>
          </div>
          <div className="cold-open-playback">
            <button type="button" disabled={disabled || Boolean(invalid)} onClick={() => void play(false)}>Play highlight</button>
            <button type="button" disabled={disabled || Boolean(invalid)} onClick={() => void play(true)}>Preview cold open</button>
          </div>
          <p>{invalid ?? `${(end - start).toFixed(2)}s highlight → full ${selection.durationSeconds.toFixed(2)}s clip · ${(selection.durationSeconds + end - start).toFixed(2)}s total`}</p>
          <small>← → nudge one frame · Shift + ← → nudge one second</small>
        </>}
        {playbackError && <p role="alert">{playbackError}</p>}
      </div>
    </div>
  )
}

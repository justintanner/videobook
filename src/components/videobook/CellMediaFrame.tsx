import { Pause, Play } from 'lucide-react'
import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react'

import { CellWaveform, CellWaveformSkeleton } from './CellWaveform'
import type { CellPreviewBadge, CellPreviewMeter } from '@/videobook/cell-preview'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'

export type CellMediaPlaybackKind = 'video' | 'audio'

type CellMediaFrameProps = {
  /** Grid address of the owning cell, for the play control's label. */
  address: string
  /** Still shown at rest. Null means the pending face takes the frame. */
  posterUrl: string | null
  /** Peaks for an audio poster; null for visual media, empty while extracting. */
  waveform: number[] | null
  mediaUrl: string | null
  playbackKind: CellMediaPlaybackKind | null
  alt: string
  title?: string
  badges: CellPreviewBadge[]
  meter: CellPreviewMeter | null
  metadataLabel: string
  pendingLabel: string
  pendingIcon: ReactNode
  children?: ReactNode
}

type MediaElement = HTMLVideoElement | HTMLAudioElement

function mediaProgress(element: MediaElement): number {
  return Number.isFinite(element.duration) && element.duration > 0
    ? Math.min(1, Math.max(0, element.currentTime / element.duration))
    : 0
}

/**
 * The one preview surface every media cell draws: a still (or a waveform) on
 * the preview ground, a badge rail naming the media, a corner meter timing it,
 * and — for anything playable — a play ring over a progress hairline.
 *
 * Playback is armed lazily: the video element mounts on hover, focus or an
 * explicit press, so a board of clips decodes nothing at rest.
 */
export function CellMediaFrame({
  address,
  posterUrl,
  waveform,
  mediaUrl,
  playbackKind,
  alt,
  title,
  badges,
  meter,
  metadataLabel,
  pendingLabel,
  pendingIcon,
  children,
}: CellMediaFrameProps) {
  const [armed, setArmed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const mediaRef = useRef<MediaElement | null>(null)
  const playOnAttach = useRef(false)

  const playable = playbackKind !== null && mediaUrl !== null
  const audioPoster = waveform !== null
  const pending = audioPoster ? waveform.length === 0 : posterUrl === null

  const attachMedia = (element: MediaElement | null) => {
    mediaRef.current = element
    if (!element || !playOnAttach.current) return
    playOnAttach.current = false
    void element.play().catch(() => setPlaying(false))
  }

  /*
   * The ring sits dead centre of the tile, where a press is as likely to mean
   * "select this cell" as "play it" — so it means both. The click keeps
   * bubbling to the board, which is what selects a cell and opens its dock,
   * and a picture and a clip answer a press in the middle the same way.
   * `nodrag` on the button is what keeps the board from dragging the cell.
   */
  const togglePlay = (event: SyntheticEvent) => {
    event.preventDefault()
    const element = mediaRef.current
    if (playing) {
      element?.pause()
      return
    }
    if (!element) {
      playOnAttach.current = true
      setArmed(true)
      return
    }
    void element.play().catch(() => setPlaying(false))
  }

  const onTimeUpdate = (event: SyntheticEvent<MediaElement>) => {
    const element = event.currentTarget
    setProgress(mediaProgress(element))
    setElapsed(element.currentTime)
  }

  const onEnded = () => {
    setPlaying(false)
    setProgress(0)
    setElapsed(0)
  }

  const meterLabel = meter && playing
    ? `${formatMediaTime(Math.floor(elapsed))} / ${meter.label}`
    : meter?.label ?? null

  return (
    <div
      className={`cell-media${playing ? ' cell-media-playing' : ''}`}
      title={title}
      onPointerEnter={() => setArmed(true)}
      onPointerLeave={() => {
        if (!playing) setArmed(false)
      }}
      onFocus={() => setArmed(true)}
    >
      {!audioPoster && posterUrl && (
        <span
          className="cell-media-backdrop"
          aria-hidden="true"
          style={{ backgroundImage: `url(${JSON.stringify(posterUrl)})` }}
        />
      )}
      {audioPoster ? (
        waveform.length > 0
          ? <CellWaveform peaks={waveform} progress={progress} />
          : <CellWaveformSkeleton />
      ) : armed && mediaUrl && playbackKind === 'video' ? (
        <video
          ref={attachMedia}
          src={mediaUrl}
          poster={posterUrl ?? undefined}
          muted={!playing}
          playsInline
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
        />
      ) : posterUrl ? (
        <img src={posterUrl} alt={alt} loading="lazy" decoding="async" />
      ) : null}

      {audioPoster && armed && mediaUrl && (
        <audio
          ref={attachMedia}
          src={mediaUrl}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
        />
      )}

      {pending && !playing && (
        <span className="cell-media-pending-face" aria-hidden="true">
          {pendingIcon}
          <span>{pendingLabel}</span>
        </span>
      )}

      {badges.length > 0 && (
        <div className="cell-media-rail" role="group" aria-label={metadataLabel}>
          {badges.map((badge) => (
            <span
              key={badge.key}
              className={`cell-media-badge${badge.emphasis === 'generator' ? ' cell-media-badge-wide' : ''}`}
              title={badge.title}
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}

      {meterLabel && meter && (
        <time
          className="cell-media-meter"
          dateTime={`PT${meter.seconds}S`}
          title="Duration"
        >
          {meterLabel}
        </time>
      )}

      {playable && (
        <button
          type="button"
          className="cell-media-play nodrag"
          aria-label={`${playing ? 'Pause' : 'Play'} ${address}`}
          onClick={togglePlay}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {playing
            ? <Pause size={13} strokeWidth={2} aria-hidden="true" />
            : <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />}
        </button>
      )}

      {playable && (
        <span className="cell-media-progress" aria-hidden="true">
          <span style={{ width: `${progress * 100}%` }} />
        </span>
      )}

      {children}
    </div>
  )
}

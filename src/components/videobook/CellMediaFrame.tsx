import type { ReactNode } from 'react'

import { CellWaveform, CellWaveformSkeleton } from './CellWaveform'
import type { CellPreviewBadge, CellPreviewMeter } from '@/videobook/cell-preview'

type CellMediaFrameProps = {
  producerAddress?: string
  /** Still shown at rest. Null means the pending face takes the frame. */
  posterUrl: string | null
  /** Peaks for an audio poster; null for visual media, empty while extracting. */
  waveform: number[] | null
  alt: string
  title?: string
  badges: CellPreviewBadge[]
  meter: CellPreviewMeter | null
  metadataLabel: string
  pendingLabel: string
  pendingIcon: ReactNode
  children?: ReactNode
}

/**
 * The one preview surface every media cell draws: a still (or a waveform) on
 * the preview ground, a badge rail naming the media and a corner meter timing
 * it. Clips never play on the board; playback lives in the cell's dock.
 */
export function CellMediaFrame({
  producerAddress,
  posterUrl,
  waveform,
  alt,
  title,
  badges,
  meter,
  metadataLabel,
  pendingLabel,
  pendingIcon,
  children,
}: CellMediaFrameProps) {
  const audioPoster = waveform !== null
  const pending = audioPoster ? waveform.length === 0 : posterUrl === null

  return (
    <div className="cell-media" title={title}>
      {!audioPoster && posterUrl && (
        <span
          className="cell-media-backdrop"
          aria-hidden="true"
          style={{ backgroundImage: `url(${JSON.stringify(posterUrl)})` }}
        />
      )}
      {audioPoster ? (
        waveform.length > 0
          ? <CellWaveform peaks={waveform} progress={0} />
          : <CellWaveformSkeleton />
      ) : posterUrl ? (
        <img src={posterUrl} alt={alt} loading="lazy" decoding="async" />
      ) : null}

      {pending && (
        <span className="cell-media-pending-face" aria-hidden="true">
          {pendingIcon}
          <span>{pendingLabel}</span>
        </span>
      )}

      {(producerAddress || badges.length > 0) && (
        <div className="cell-media-rail" role="group" aria-label={metadataLabel}>
          {producerAddress && (
            <span className="cell-media-badge cell-media-source" title={`Source ${producerAddress}`}>
              ↳ {producerAddress}
            </span>
          )}
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

      {meter && (
        <time
          className="cell-media-meter"
          dateTime={`PT${meter.seconds}S`}
          title="Duration"
        >
          {meter.label}
        </time>
      )}

      {children}
    </div>
  )
}

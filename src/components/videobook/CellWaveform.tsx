import { useId, useMemo } from 'react'

import {
  waveformBarsPath,
  waveformSkeletonPath,
  type WaveformBarsOptions,
} from '@/videobook/waveform-path'

/**
 * The audio cell's poster: peaks drawn edge to edge on the preview ground, so
 * an audio cell is a picture like every other media cell.
 *
 * The box matches a cell's media area at rest; `preserveAspectRatio="none"`
 * lets it stretch with the frame while the bar pitch stays legible.
 */
const waveformBox: WaveformBarsOptions = {
  width: 240,
  height: 156,
  pitch: 4,
  minimumBarHeight: 4,
}

export function CellWaveform({
  peaks,
  progress,
}: {
  peaks: number[]
  progress: number
}) {
  const clipId = `played${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const path = useMemo(() => waveformBarsPath(peaks, waveformBox), [peaks])
  const played = Math.min(1, Math.max(0, progress))
  const playedWidth = waveformBox.width * played

  if (!path) return <CellWaveformSkeleton />

  return (
    <svg
      className="cell-waveform"
      viewBox={`0 0 ${waveformBox.width} ${waveformBox.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="cell-waveform-midline" d={`M0 ${waveformBox.height / 2}h${waveformBox.width}`} />
      <path className="cell-waveform-bars" d={path} />
      {played > 0 && (
        <>
          <defs>
            <clipPath id={clipId}>
              <rect x="0" y="0" width={playedWidth} height={waveformBox.height} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            <path className="cell-waveform-played" d={path} />
          </g>
          <path
            className="cell-waveform-playhead"
            d={`M${playedWidth} 8V${waveformBox.height - 8}`}
          />
        </>
      )}
    </svg>
  )
}

/** The flat run drawn while `extract_waveform` is still on the queue. */
export function CellWaveformSkeleton() {
  const path = useMemo(() => waveformSkeletonPath(waveformBox), [])

  return (
    <svg
      className="cell-waveform cell-waveform-pending"
      viewBox={`0 0 ${waveformBox.width} ${waveformBox.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="cell-waveform-midline" d={`M0 ${waveformBox.height / 2}h${waveformBox.width}`} />
      <path className="cell-waveform-bars" d={path} />
    </svg>
  )
}

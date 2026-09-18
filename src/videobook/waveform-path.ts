/**
 * Waveform geometry shared by every surface that draws peaks: the music video
 * editor timeline, the notebook cell preview, and the inspector.
 *
 * `waveformEnvelopePath` draws into a 0-100 square (the editor's viewBox).
 * `waveformBarsPath` draws mirrored bars into an explicit box, which is what a
 * cell preview needs so the bars keep their pitch whatever the frame size.
 */

const envelopeMaximumSamples = 720

export type WaveformBarsOptions = {
  width: number
  height: number
  /** Distance between bar centres, in the same units as `width`. */
  pitch: number
  /** Shortest bar drawn, so silence still reads as a line of peaks. */
  minimumBarHeight: number
}

function absolutePeak(peak: number): number {
  return Math.abs(peak)
}

/** Largest absolute peak in each bucket of `step` samples. */
function bucketPeaks(peaks: number[], step: number): number[] {
  const values: number[] = []
  for (let index = 0; index < peaks.length; index += step) {
    values.push(Math.max(...peaks.slice(index, index + step).map(absolutePeak)))
  }
  return values
}

/** Peaks resampled to exactly `count` buckets, each the bucket's loudest sample. */
function resamplePeaks(peaks: number[], count: number): number[] {
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * peaks.length / count)
    const end = Math.max(start + 1, Math.floor((index + 1) * peaks.length / count))
    values.push(Math.max(...peaks.slice(start, end).map(absolutePeak)))
  }
  return values
}

/**
 * Peaks as vertical strokes mirrored around the midline of a 0-100 square,
 * spread edge to edge. Empty peaks give an empty path.
 */
export function waveformEnvelopePath(peaks: number[]): string {
  if (peaks.length === 0) return ''
  const step = Math.max(1, Math.ceil(peaks.length / envelopeMaximumSamples))
  const values = bucketPeaks(peaks, step)
  return values.map((peak, index) => {
    const x = values.length === 1 ? 50 : index / (values.length - 1) * 100
    const amplitude = Math.max(2, Math.min(46, peak * 46))
    return `M${x.toFixed(3)} ${50 - amplitude}V${50 + amplitude}`
  }).join('')
}

/**
 * Peaks as mirrored bars on a fixed pitch, filling `width` x `height`. The
 * first bar sits half a pitch in from the left edge so the run is centred.
 */
export function waveformBarsPath(
  peaks: number[],
  options: WaveformBarsOptions,
): string {
  const { width, height, pitch, minimumBarHeight } = options
  const barCount = Math.floor(width / pitch)
  if (peaks.length === 0 || barCount < 1) return ''
  const values = resamplePeaks(peaks, barCount)
  const loudest = Math.max(...values)
  const middle = height / 2
  const tallest = height - minimumBarHeight
  return values.map((peak, index) => {
    const x = pitch * index + pitch / 2
    const scaled = loudest > 0 ? peak / loudest : 0
    const barHeight = Math.max(minimumBarHeight, scaled * tallest)
    const top = middle - barHeight / 2
    const bottom = middle + barHeight / 2
    return `M${x.toFixed(2)} ${top.toFixed(2)}V${bottom.toFixed(2)}`
  }).join('')
}

/**
 * The flat run of bars drawn while peaks are still being extracted: the same
 * geometry as `waveformBarsPath`, at rest.
 */
export function waveformSkeletonPath(options: WaveformBarsOptions): string {
  const { width, height, pitch, minimumBarHeight } = options
  const barCount = Math.floor(width / pitch)
  if (barCount < 1) return ''
  const middle = height / 2
  const top = (middle - minimumBarHeight / 2).toFixed(2)
  const bottom = (middle + minimumBarHeight / 2).toFixed(2)
  return Array.from({ length: barCount }, (_unused, index) => {
    const x = pitch * index + pitch / 2
    return `M${x.toFixed(2)} ${top}V${bottom}`
  }).join('')
}

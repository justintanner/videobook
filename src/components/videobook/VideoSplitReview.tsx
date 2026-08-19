import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  Check,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { minimumSplitChunkSeconds } from '@/videobook/notebook-split-command'
import {
  formatSplitTimestamp,
  insertSplitCutPoint,
  nudgeSplitCutPoint,
  removeSplitCutPoint,
  splitPreviewWindows,
  type SplitPreviewWindow,
} from '@/videobook/video-split-review'

type PreviewSide = 'after' | 'before'

type SplitLoopPreviewProps = {
  active: boolean
  label: string
  mediaUrl: string
  muted: boolean
  onActivate: () => void
  side: PreviewSide
  window: SplitPreviewWindow
}

function SplitLoopPreview({
  active,
  label,
  mediaUrl,
  muted,
  onActivate,
  side,
  window,
}: SplitLoopPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const startPlayback = () => {
      video.currentTime = window.startSeconds
      void video.play().catch(() => undefined)
    }
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      startPlayback()
      return
    }
    video.addEventListener('loadedmetadata', startPlayback, { once: true })
    return () => video.removeEventListener('loadedmetadata', startPlayback)
  }, [mediaUrl, window.endSeconds, window.startSeconds])

  return (
    <section className={active
      ? 'video-split-loop active'
      : 'video-split-loop'}>
      <button
        type="button"
        className="video-split-loop-heading"
        aria-pressed={active}
        onClick={onActivate}
      >
        <span>{side === 'before' ? 'OUTGOING' : 'INCOMING'}</span>
        <strong>{label}</strong>
      </button>
      <video
        ref={videoRef}
        aria-label={`${label} cut preview`}
        src={mediaUrl}
        muted={muted}
        playsInline
        preload="auto"
        onClick={onActivate}
        onTimeUpdate={(event) => {
          const video = event.currentTarget
          if (
            video.currentTime < window.startSeconds
            || video.currentTime >= window.endSeconds - 0.025
          ) {
            video.currentTime = window.startSeconds
            void video.play().catch(() => undefined)
          }
        }}
      />
      <small>
        {formatSplitTimestamp(window.startSeconds)}–{formatSplitTimestamp(window.endSeconds)}
      </small>
    </section>
  )
}

type VideoSplitReviewProps = {
  applyFormId: string
  busy: boolean
  cutPointsSeconds: number[]
  maxChunkCount: number
  mediaUrl: string
  onCancel: () => void
  onCutPointsChange: (cutPointsSeconds: number[]) => void
  sourceDurationSeconds: number
  sourceLabel: string
}

export function VideoSplitReview({
  applyFormId,
  busy,
  cutPointsSeconds,
  maxChunkCount,
  mediaUrl,
  onCancel,
  onCutPointsChange,
  sourceDurationSeconds,
  sourceLabel,
}: VideoSplitReviewProps) {
  const [activeSide, setActiveSide] = useState<PreviewSide>('before')
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [selectedCutIndex, setSelectedCutIndex] = useState(0)
  const [timeInput, setTimeInput] = useState(
    String(cutPointsSeconds[0] ?? ''),
  )
  const [validationError, setValidationError] = useState<string | null>(null)
  const selectedCut = cutPointsSeconds[selectedCutIndex] ?? cutPointsSeconds[0]!
  const previousBoundary = cutPointsSeconds[selectedCutIndex - 1] ?? 0
  const nextBoundary = cutPointsSeconds[selectedCutIndex + 1]
    ?? sourceDurationSeconds
  const windows = useMemo(() => splitPreviewWindows({
    cutPointSeconds: selectedCut,
    nextBoundarySeconds: nextBoundary,
    previousBoundarySeconds: previousBoundary,
  }), [nextBoundary, previousBoundary, selectedCut])

  const selectCut = (index: number) => {
    setSelectedCutIndex(index)
    setTimeInput(String(cutPointsSeconds[index] ?? ''))
    setValidationError(null)
    setActiveSide('before')
  }
  const updateCuts = (cutPoints: number[], selectedIndex = selectedCutIndex) => {
    const nextIndex = Math.min(selectedIndex, Math.max(0, cutPoints.length - 1))
    setSelectedCutIndex(nextIndex)
    setTimeInput(String(cutPoints[nextIndex] ?? ''))
    setValidationError(null)
    onCutPointsChange(cutPoints)
  }
  const nudge = (deltaSeconds: number) => {
    updateCuts(nudgeSplitCutPoint({
      cutPointsSeconds,
      deltaSeconds,
      index: selectedCutIndex,
      sourceDurationSeconds,
    }))
  }
  const addCut = (chunkIndex: number) => {
    if (cutPointsSeconds.length + 2 > maxChunkCount) return
    const nextCuts = insertSplitCutPoint({
      chunkIndex,
      cutPointsSeconds,
      sourceDurationSeconds,
    })
    if (nextCuts.length === cutPointsSeconds.length) return
    updateCuts(nextCuts, chunkIndex)
  }
  const commitTimeInput = () => {
    const value = Math.round(Number(timeInput) * 1000) / 1000
    const minimum = previousBoundary + minimumSplitChunkSeconds
    const maximum = nextBoundary - minimumSplitChunkSeconds
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      setValidationError(
        `Choose a time from ${formatSplitTimestamp(minimum)} to ${formatSplitTimestamp(maximum)}`,
      )
      return
    }
    updateCuts(cutPointsSeconds.map((cutPoint, index) =>
      index === selectedCutIndex ? value : cutPoint))
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    if (event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    nudge(direction * (event.shiftKey ? 1 : 0.1))
  }
  const boundaries = [0, ...cutPointsSeconds, sourceDurationSeconds]
  const applyDisabled = busy
    || cutPointsSeconds.length < 1
    || cutPointsSeconds.length + 1 > maxChunkCount

  return (
    <aside
      className="command-plan-drawer video-split-review"
      aria-label="Video split review"
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Escape"
      onKeyDown={handleKeyDown}
    >
      <header>
        <div className="command-plan-heading">
          <span className="section-label">SPLIT VIDEO · {sourceLabel}</span>
          <h2>{cutPointsSeconds.length + 1} contiguous chunks</h2>
        </div>
        <div className="command-plan-primary-actions">
          <button
            type="submit"
            form={applyFormId}
            className="command-plan-apply"
            disabled={applyDisabled}
          >
            <Check size={14} />Apply split
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            <X size={14} />Cancel
          </button>
        </div>
      </header>
      <div className="video-split-editor">
        <section className="video-split-boundaries" aria-label="Chunks and cut points">
          <div className="video-split-section-heading">
            <span>CHUNKS</span>
            <small>{formatSplitTimestamp(sourceDurationSeconds)} total</small>
          </div>
          <ol>
            {boundaries.slice(0, -1).map((startSeconds, chunkIndex) => {
              const endSeconds = boundaries[chunkIndex + 1]!
              const canBisect = endSeconds - startSeconds
                >= minimumSplitChunkSeconds * 2
                && cutPointsSeconds.length + 2 <= maxChunkCount
              return (
                <li key={`${startSeconds}:${endSeconds}`}>
                  <div className="video-split-chunk-row">
                    <span>Chunk {String(chunkIndex + 1).padStart(2, '0')}</span>
                    <strong>
                      {formatSplitTimestamp(startSeconds)}–{formatSplitTimestamp(endSeconds)}
                    </strong>
                    <button
                      type="button"
                      disabled={!canBisect}
                      onClick={() => addCut(chunkIndex)}
                    >
                      <Scissors size={12} />Split chunk
                    </button>
                  </div>
                  {chunkIndex < cutPointsSeconds.length && (
                    <button
                      type="button"
                      className={selectedCutIndex === chunkIndex
                        ? 'video-split-cut-row active'
                        : 'video-split-cut-row'}
                      aria-pressed={selectedCutIndex === chunkIndex}
                      onClick={() => selectCut(chunkIndex)}
                    >
                      <span>Cut {chunkIndex + 1}</span>
                      <strong>{formatSplitTimestamp(cutPointsSeconds[chunkIndex]!)}</strong>
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
          {cutPointsSeconds.length + 1 > maxChunkCount && (
            <p className="video-split-error">The notebook does not have enough empty cells for this split.</p>
          )}
        </section>
        <section className="video-split-preview-section">
          <div className="video-split-section-heading">
            <span>CUT {selectedCutIndex + 1} PREVIEW</span>
            <button
              type="button"
              aria-pressed={soundEnabled}
              onClick={() => setSoundEnabled((current) => !current)}
            >
              {soundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
              {soundEnabled ? `Sound: ${activeSide}` : 'Sound off'}
            </button>
          </div>
          <div className="video-split-loops">
            <SplitLoopPreview
              active={activeSide === 'before'}
              label="Before cut"
              mediaUrl={mediaUrl}
              muted={!soundEnabled || activeSide !== 'before'}
              onActivate={() => setActiveSide('before')}
              side="before"
              window={windows.before}
            />
            <SplitLoopPreview
              active={activeSide === 'after'}
              label="After cut"
              mediaUrl={mediaUrl}
              muted={!soundEnabled || activeSide !== 'after'}
              onActivate={() => setActiveSide('after')}
              side="after"
              window={windows.after}
            />
          </div>
          <div className="video-split-adjustment">
            <span>NUDGE CUT</span>
            <div className="video-split-nudge-buttons">
              {[-1, -0.1, 0.1, 1].map((delta) => (
                <button
                  key={delta}
                  type="button"
                  disabled={nudgeSplitCutPoint({
                    cutPointsSeconds,
                    deltaSeconds: delta,
                    index: selectedCutIndex,
                    sourceDurationSeconds,
                  })[selectedCutIndex] === selectedCut}
                  onClick={() => nudge(delta)}
                >
                  {delta > 0 ? '+' : '−'}{Math.abs(delta)}s
                </button>
              ))}
            </div>
            <label>
              Exact seconds
              <input
                type="number"
                min={previousBoundary + minimumSplitChunkSeconds}
                max={nextBoundary - minimumSplitChunkSeconds}
                step="0.001"
                value={timeInput}
                onBlur={commitTimeInput}
                onChange={(event) => setTimeInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitTimeInput()
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="video-split-remove"
              disabled={cutPointsSeconds.length <= 1}
              onClick={() => updateCuts(
                removeSplitCutPoint(cutPointsSeconds, selectedCutIndex),
                Math.max(0, selectedCutIndex - 1),
              )}
            >
              <Trash2 size={13} />Remove cut
            </button>
            {validationError && (
              <p className="video-split-error" role="alert">{validationError}</p>
            )}
            <small>Arrow keys move 0.1s · Shift+Arrow moves 1s</small>
          </div>
        </section>
      </div>
    </aside>
  )
}

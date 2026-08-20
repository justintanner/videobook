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
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  formatSplitTimestamp,
  notebookSplitCellBudget,
  splitFrameStepSeconds,
  type NotebookSplitOutputMode,
} from '@/videobook/notebook-split-command'
import {
  defaultSlowLoopPlayback,
  nextSegmentLoopAction,
} from '@/videobook/segment-loop-playback'
import {
  mergeSegmentWithNext,
  moveSegment,
  moveSegmentEnd,
  moveSegmentStart,
  previewWindows,
  setSegmentBounds,
  splitSegmentInHalf,
  splitSegments,
} from '@/videobook/video-split-segments'

type LoopTileProps = {
  label: string
  mediaUrl: string
  muted: boolean
  playbackRate: number
  windows: Array<{ endSeconds: number; startSeconds: number }>
}

function SegmentLoopTile({
  label,
  mediaUrl,
  muted,
  playbackRate,
  windows,
}: LoopTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const windowIndexRef = useRef(0)
  const windowsKey = windows
    .map((window) => `${window.startSeconds}:${window.endSeconds}`)
    .join('|')

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const parsedWindows = windowsKey.split('|').flatMap((part) => {
      const [start, end] = part.split(':').map(Number)
      return Number.isFinite(start) && Number.isFinite(end) && end! > start!
        ? [{ startSeconds: start!, endSeconds: end! }]
        : []
    })
    windowIndexRef.current = 0
    const startSeconds = parsedWindows[0]?.startSeconds ?? 0
    const startPlayback = () => {
      video.currentTime = startSeconds
      pendingSeekRef.current = startSeconds
      video.playbackRate = playbackRate
      void video.play().catch(() => undefined)
    }
    let raf = 0
    let vfc: number | undefined
    let cancelled = false
    const cancelArm = () => {
      if (vfc !== undefined && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(vfc)
        vfc = undefined
      }
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    const tick = () => {
      if (cancelled) return
      const action = nextSegmentLoopAction({
        activeWindowIndex: windowIndexRef.current,
        currentTimeSeconds: video.currentTime,
        pendingSeekSeconds: pendingSeekRef.current,
        windows: parsedWindows,
      })
      if (action.type === 'seek') {
        video.currentTime = action.timeSeconds
        pendingSeekRef.current = action.timeSeconds
        windowIndexRef.current = action.windowIndex
        void video.play().catch(() => undefined)
      } else if (
        pendingSeekRef.current !== null
        && Math.abs(video.currentTime - pendingSeekRef.current) <= 1 / 30
      ) {
        pendingSeekRef.current = null
      }
      arm()
    }
    const arm = () => {
      if (cancelled) return
      if (typeof video.requestVideoFrameCallback === 'function') {
        vfc = video.requestVideoFrameCallback(() => tick())
        return
      }
      raf = requestAnimationFrame(() => tick())
    }
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      startPlayback()
    } else {
      video.addEventListener('loadedmetadata', startPlayback, { once: true })
    }
    arm()
    return () => {
      cancelled = true
      cancelArm()
      video.removeEventListener('loadedmetadata', startPlayback)
    }
  }, [mediaUrl, playbackRate, windowsKey])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate])

  const span = windows[0]
    ? `${formatSplitTimestamp(windows[0].startSeconds)}–${formatSplitTimestamp(windows[windows.length - 1]!.endSeconds)}`
    : ''

  return (
    <section className="video-segment-loop">
      <div className="video-segment-loop-heading">
        <span>{label}</span>
        <strong>{span}</strong>
      </div>
      <video
        ref={videoRef}
        aria-label={label}
        src={mediaUrl}
        muted={muted}
        playsInline
        preload="auto"
      />
    </section>
  )
}

const NUDGE_STEPS = [-1, -0.1, -0.01, 0.01, 0.1, 1] as const
const MOVE_STEPS = [-1, -0.1, 0.1, 1] as const

type VideoSegmentSplitProps = {
  applyFormId: string
  availableEmptyCells: number
  busy: boolean
  cutPointsSeconds: number[]
  mediaUrl: string
  onCancel: () => void
  onChange: (next: {
    cutPointsSeconds: number[]
    outputMode: NotebookSplitOutputMode
    selectedIndex: number
  }) => void
  outputMode: NotebookSplitOutputMode
  selectedIndex: number
  sourceDurationSeconds: number
  sourceFps?: number | null
  sourceLabel: string
}

export function VideoSegmentSplit({
  applyFormId,
  availableEmptyCells,
  busy,
  cutPointsSeconds,
  mediaUrl,
  onCancel,
  onChange,
  outputMode,
  selectedIndex,
  sourceDurationSeconds,
  sourceFps,
  sourceLabel,
}: VideoSegmentSplitProps) {
  const sourceRef = useRef<HTMLVideoElement>(null)
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [focusedBound, setFocusedBound] = useState<'in' | 'out'>('in')
  const [inDraft, setInDraft] = useState<string | null>(null)
  const [outDraft, setOutDraft] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [slowOverride, setSlowOverride] = useState<{
    key: string
    value: boolean
  } | null>(null)
  const segments = useMemo(() => splitSegments({
    cutPointsSeconds,
    sourceDurationSeconds,
  }), [cutPointsSeconds, sourceDurationSeconds])
  const selected = segments[selectedIndex] ?? segments[0]
  const frameStep = splitFrameStepSeconds(sourceFps)
  const windows = useMemo(() => selected
    ? previewWindows({
        segment: selected,
        sourceDurationSeconds,
      })
    : { segment: { startSeconds: 0, endSeconds: 0 }, surroundings: [] },
  [selected, sourceDurationSeconds])
  const pieceKey = selected
    ? `${selected.startSeconds}:${selected.endSeconds}`
    : ''
  const inInput = inDraft ?? selected?.startSeconds.toFixed(3) ?? ''
  const outInput = outDraft ?? selected?.endSeconds.toFixed(3) ?? ''
  const slowPlayback = slowOverride?.key === pieceKey
    ? slowOverride.value
    : defaultSlowLoopPlayback(selected?.durationSeconds ?? 1)

  const emit = (next: {
    cutPointsSeconds: number[]
    outputMode?: NotebookSplitOutputMode
    selectedIndex: number
  }) => {
    setValidationError(null)
    setInDraft(null)
    setOutDraft(null)
    onChange({
      cutPointsSeconds: next.cutPointsSeconds,
      outputMode: next.outputMode ?? outputMode,
      selectedIndex: next.selectedIndex,
    })
  }
  const applyEdit = (edit: { cutPointsSeconds: number[]; selectedIndex: number }) => {
    setInDraft(null)
    setOutDraft(null)
    emit(edit)
  }
  const nudgeIn = (deltaSeconds: number) => {
    applyEdit(moveSegmentStart({
      cutPointsSeconds,
      deltaSeconds,
      index: selectedIndex,
      sourceDurationSeconds,
    }))
  }
  const nudgeOut = (deltaSeconds: number) => {
    applyEdit(moveSegmentEnd({
      cutPointsSeconds,
      deltaSeconds,
      index: selectedIndex,
      sourceDurationSeconds,
    }))
  }
  const commitBounds = (startValue: string, endValue: string) => {
    if (!selected) return
    const startSeconds = Math.round(Number(startValue) * 1000) / 1000
    const endSeconds = Math.round(Number(endValue) * 1000) / 1000
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      setValidationError('Enter start and end times in seconds')
      return
    }
    const edit = setSegmentBounds({
      cutPointsSeconds,
      endSeconds,
      index: selectedIndex,
      sourceDurationSeconds,
      startSeconds,
    })
    if (
      edit.cutPointsSeconds.length === cutPointsSeconds.length
      && edit.cutPointsSeconds.every((value, index) => value === cutPointsSeconds[index])
      && (startSeconds !== selected.startSeconds || endSeconds !== selected.endSeconds)
    ) {
      setValidationError(
        `Choose a range from ${formatSplitTimestamp(selected.startSeconds)} that stays inside neighbouring pieces`,
      )
      setInDraft(null)
      setOutDraft(null)
      return
    }
    applyEdit(edit)
  }
  const setFromPlayer = (bound: 'in' | 'out') => {
    const currentTime = sourceRef.current?.currentTime
    if (!selected || typeof currentTime !== 'number' || !Number.isFinite(currentTime)) {
      return
    }
    applyEdit(setSegmentBounds({
      cutPointsSeconds,
      endSeconds: bound === 'out' ? currentTime : selected.endSeconds,
      index: selectedIndex,
      sourceDurationSeconds,
      startSeconds: bound === 'in' ? currentTime : selected.startSeconds,
    }))
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    if (event.target instanceof HTMLInputElement) return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    const step = event.altKey ? 0.01 : event.shiftKey ? 1 : 0.1
    if (focusedBound === 'out') nudgeOut(direction * step)
    else nudgeIn(direction * step)
  }
  const neededCells = notebookSplitCellBudget(outputMode, segments.length)
  const applyDisabled = busy
    || !selected
    || availableEmptyCells < neededCells
    || (outputMode === 'remove' && segments.length < 2)
  const playbackRate = slowPlayback ? 0.25 : 1
  const surroundingsLabel = outputMode === 'remove'
    ? 'JOIN PREVIEW'
    : 'SURROUNDINGS'
  const outputSummary = selected
    ? outputMode === 'all'
      ? `Apply creates ${segments.length} cells`
      : outputMode === 'keep'
        ? `Apply creates 1 cell: ${formatSplitTimestamp(selected.startSeconds)}-${formatSplitTimestamp(selected.endSeconds)}`
        : `Apply creates 1 cell without ${formatSplitTimestamp(selected.startSeconds)}-${formatSplitTimestamp(selected.endSeconds)}`
    : ''

  return (
    <aside
      className="command-plan-drawer video-segment-split"
      aria-label="Video split review"
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight Escape"
      onKeyDown={handleKeyDown}
    >
      <header>
        <div className="command-plan-heading">
          <span className="section-label">SPLIT VIDEO · {sourceLabel}</span>
          <h2>
            {selected
              ? `Cutting ${formatSplitTimestamp(selected.startSeconds)}-${formatSplitTimestamp(selected.endSeconds)} (${selected.durationSeconds.toFixed(3)}s)`
              : 'Split video'}
          </h2>
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
      <div className="video-segment-editor">
        <section className="video-segment-source" aria-label="Source player">
          <div className="video-segment-section-heading">
            <span>SOURCE</span>
            <small>{formatSplitTimestamp(sourceDurationSeconds)} total</small>
          </div>
          <video
            ref={sourceRef}
            src={mediaUrl}
            controls
            playsInline
            preload="metadata"
          />
          <div className="video-segment-source-actions">
            <button type="button" onClick={() => setFromPlayer('in')}>
              SET IN HERE
            </button>
            <button type="button" onClick={() => setFromPlayer('out')}>
              SET OUT HERE
            </button>
          </div>
        </section>
        <section className="video-segment-pieces" aria-label="Pieces">
          <div className="video-segment-section-heading">
            <span>PIECES</span>
          </div>
          <div className="video-segment-piece-row" role="list">
            {segments.map((segment) => (
              <button
                key={`${segment.startSeconds}:${segment.endSeconds}`}
                type="button"
                role="listitem"
                className={segment.index === selectedIndex
                  ? 'video-segment-piece active'
                  : 'video-segment-piece'}
                aria-pressed={segment.index === selectedIndex}
                onClick={() => emit({
                  cutPointsSeconds,
                  selectedIndex: segment.index,
                })}
              >
                {String(segment.index + 1).padStart(2, '0')}{' '}
                {formatSplitTimestamp(segment.startSeconds)}-{formatSplitTimestamp(segment.endSeconds)}
              </button>
            ))}
          </div>
          <div className="video-segment-piece-actions">
            <button
              type="button"
              disabled={!selected || selected.durationSeconds < 0.04}
              onClick={() => applyEdit(splitSegmentInHalf({
                cutPointsSeconds,
                index: selectedIndex,
                sourceDurationSeconds,
              }))}
            >
              <Scissors size={12} />Split piece in half
            </button>
            <button
              type="button"
              disabled={selectedIndex >= segments.length - 1}
              onClick={() => applyEdit(mergeSegmentWithNext({
                cutPointsSeconds,
                index: selectedIndex,
                sourceDurationSeconds,
              }))}
            >
              Merge with next
            </button>
          </div>
        </section>
        <section className="video-segment-preview-section">
          <div className="video-segment-section-heading">
            <span>LOOPS</span>
            <button
              type="button"
              aria-pressed={soundEnabled}
              onClick={() => setSoundEnabled((current) => !current)}
            >
              {soundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
              {soundEnabled ? 'Sound on' : 'Sound off'}
            </button>
          </div>
          <div className="video-segment-loops">
            <SegmentLoopTile
              label="SEGMENT"
              mediaUrl={mediaUrl}
              muted={!soundEnabled}
              playbackRate={playbackRate}
              windows={[windows.segment]}
            />
            <SegmentLoopTile
              label={surroundingsLabel}
              mediaUrl={mediaUrl}
              muted={!soundEnabled}
              playbackRate={playbackRate}
              windows={windows.surroundings}
            />
          </div>
          {selected && (
            <div className="video-segment-adjustment">
              <div className="video-segment-bound-row">
                <span>IN</span>
                <strong>{formatSplitTimestamp(selected.startSeconds)}</strong>
                <div className="video-segment-nudge-buttons">
                  {NUDGE_STEPS.map((delta) => {
                    const next = moveSegmentStart({
                      cutPointsSeconds,
                      deltaSeconds: delta,
                      index: selectedIndex,
                      sourceDurationSeconds,
                    })
                    const disabled = next.cutPointsSeconds.every((value, index) =>
                      value === cutPointsSeconds[index])
                      && next.selectedIndex === selectedIndex
                    return (
                      <button
                        key={`in:${delta}`}
                        type="button"
                        disabled={disabled}
                        onFocus={() => setFocusedBound('in')}
                        onClick={() => nudgeIn(delta)}
                      >
                        {delta > 0 ? '+' : '−'}{Math.abs(delta)}s
                      </button>
                    )
                  })}
                  {frameStep !== null && (
                    <>
                      <button
                        type="button"
                        onFocus={() => setFocusedBound('in')}
                        onClick={() => nudgeIn(-frameStep)}
                      >
                        PREV FRAME
                      </button>
                      <button
                        type="button"
                        onFocus={() => setFocusedBound('in')}
                        onClick={() => nudgeIn(frameStep)}
                      >
                        NEXT FRAME
                      </button>
                    </>
                  )}
                </div>
                <label>
                  IN seconds
                  <input
                    type="number"
                    step="0.001"
                    value={inInput}
                    onFocus={() => setFocusedBound('in')}
                    onChange={(event) => setInDraft(event.target.value)}
                    onBlur={() => commitBounds(inInput, outInput)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitBounds(inInput, outInput)
                      }
                    }}
                  />
                </label>
              </div>
              <div className="video-segment-bound-row">
                <span>OUT</span>
                <strong>{formatSplitTimestamp(selected.endSeconds)}</strong>
                <div className="video-segment-nudge-buttons">
                  {NUDGE_STEPS.map((delta) => {
                    const next = moveSegmentEnd({
                      cutPointsSeconds,
                      deltaSeconds: delta,
                      index: selectedIndex,
                      sourceDurationSeconds,
                    })
                    const disabled = next.cutPointsSeconds.every((value, index) =>
                      value === cutPointsSeconds[index])
                      && next.selectedIndex === selectedIndex
                    return (
                      <button
                        key={`out:${delta}`}
                        type="button"
                        disabled={disabled}
                        onFocus={() => setFocusedBound('out')}
                        onClick={() => nudgeOut(delta)}
                      >
                        {delta > 0 ? '+' : '−'}{Math.abs(delta)}s
                      </button>
                    )
                  })}
                  {frameStep !== null && (
                    <>
                      <button
                        type="button"
                        onFocus={() => setFocusedBound('out')}
                        onClick={() => nudgeOut(-frameStep)}
                      >
                        PREV FRAME
                      </button>
                      <button
                        type="button"
                        onFocus={() => setFocusedBound('out')}
                        onClick={() => nudgeOut(frameStep)}
                      >
                        NEXT FRAME
                      </button>
                    </>
                  )}
                </div>
                <label>
                  OUT seconds
                  <input
                    type="number"
                    step="0.001"
                    value={outInput}
                    onFocus={() => setFocusedBound('out')}
                    onChange={(event) => setOutDraft(event.target.value)}
                    onBlur={() => commitBounds(inInput, outInput)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitBounds(inInput, outInput)
                      }
                    }}
                  />
                </label>
              </div>
              <div className="video-segment-bound-row">
                <span>MOVE BOTH</span>
                <strong>{selected.durationSeconds.toFixed(3)}s</strong>
                <div className="video-segment-nudge-buttons">
                  {MOVE_STEPS.map((delta) => {
                    const next = moveSegment({
                      cutPointsSeconds,
                      deltaSeconds: delta,
                      index: selectedIndex,
                      sourceDurationSeconds,
                    })
                    const disabled = next.cutPointsSeconds.every((value, index) =>
                      value === cutPointsSeconds[index])
                    return (
                      <button
                        key={`move:${delta}`}
                        type="button"
                        disabled={disabled}
                        onClick={() => applyEdit(next)}
                      >
                        {delta > 0 ? '+' : '−'}{Math.abs(delta)}s
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    aria-pressed={slowPlayback}
                    onClick={() => setSlowOverride({
                      key: pieceKey,
                      value: !slowPlayback,
                    })}
                  >
                    Slow x0.25
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
        <section className="video-segment-output" aria-label="Output mode">
          <div className="video-segment-section-heading">
            <span>OUTPUT</span>
          </div>
          <div className="video-segment-modes">
            {([
              ['keep', 'KEEP segment'],
              ['remove', 'REMOVE segment'],
              ['all', 'ALL pieces'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={outputMode === mode ? 'active' : undefined}
                aria-pressed={outputMode === mode}
                disabled={mode === 'remove' && segments.length < 2}
                onClick={() => emit({
                  cutPointsSeconds,
                  outputMode: mode,
                  selectedIndex,
                })}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="video-segment-output-summary">{outputSummary}</p>
          {availableEmptyCells < neededCells && (
            <p className="video-segment-error">
              The notebook needs {neededCells} empty cells for this split.
            </p>
          )}
          {validationError && (
            <p className="video-segment-error" role="alert">{validationError}</p>
          )}
          <small>Arrow keys move 0.1s · Shift+Arrow 1s · Alt+Arrow 0.01s</small>
        </section>
      </div>
    </aside>
  )
}

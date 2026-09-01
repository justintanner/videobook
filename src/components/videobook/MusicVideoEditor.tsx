import {
  AudioWaveform,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  Gauge,
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { Sequence, SequenceClip, TimedSequenceClip } from 'videobook-engine'
import {
  CanonicalSequencePlayer,
  type CanonicalSequencePlayerHandle,
  type TimelineKeyboardAction,
} from './CanonicalSequencePlayer'
import './MusicVideoEditor.css'

export type MusicVideoAsset = {
  artifactId: string
  label: string
  type: string
  status: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  duration: number | null
  waveform: number[] | null
}

export type MusicVideoSetupState =
  | { status: 'loading' }
  | { status: 'needs-audio-track'; message: string }
  | {
      status: 'ready'
      audioTrackId: string
      timelineLimitFrame: number
      operationCount: number
      summary: string
      warnings: string[]
    }
  | {
      status: 'applying'
      audioTrackId: string
      timelineLimitFrame: number
      operationCount: number
      summary: string
      warnings: string[]
    }
  | {
      status: 'applied'
      audioTrackId: string
      timelineLimitFrame: number
    }
  | { status: 'error'; message: string }

export type MusicVideoCommitResult = {
  sequence: Sequence
  actionId: string
  beforeRevision: string
}

type MusicVideoEditorProps = {
  sequence: Sequence
  assets: MusicVideoAsset[]
  audioArtifactId: string
  setup: MusicVideoSetupState
  returnFocus: HTMLElement | null
  onApplySetup: () => Promise<MusicVideoCommitResult>
  onClose: () => void
  onCommit: (
    request: Record<string, unknown>,
    expectedSequence: Sequence,
  ) => Promise<MusicVideoCommitResult>
  onCreateTrack: (kind: 'video' | 'audio') => Promise<Sequence>
  onRefreshAssets: () => Promise<void>
  onRestore: (
    targetRevision: string,
    expectedRevision: string,
  ) => Promise<MusicVideoCommitResult>
  onReviewSetup: (sequence?: Sequence) => Promise<void>
}

type RevisionStep = {
  beforeRevision: string
  afterRevision: string
}

type TrimDraft = {
  clipId: string
  startFrame: number
  endFrame: number
}

const SPEEDS = [
  { label: '0.25×', value: '1/4', numerator: 1, denominator: 4 },
  { label: '0.5×', value: '1/2', numerator: 1, denominator: 2 },
  { label: '0.75×', value: '3/4', numerator: 3, denominator: 4 },
  { label: '1×', value: '1/1', numerator: 1, denominator: 1 },
  { label: '1.25×', value: '5/4', numerator: 5, denominator: 4 },
  { label: '1.5×', value: '3/2', numerator: 3, denominator: 2 },
  { label: '2×', value: '2/1', numerator: 2, denominator: 1 },
  { label: '3×', value: '3/1', numerator: 3, denominator: 1 },
  { label: '4×', value: '4/1', numerator: 4, denominator: 1 },
] as const

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden)
}

function clipEnd(clip: SequenceClip): number {
  return clip.timelineStartFrame + clip.durationFrames
}

function formatTime(frame: number, fps: number): string {
  const seconds = Math.max(0, frame / fps)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return `${minutes}:${remainder.toFixed(2).padStart(5, '0')}`
}

function clipStyle(
  clip: SequenceClip,
  durationFrames: number,
): CSSProperties {
  return {
    '--music-video-clip-start': `${clip.timelineStartFrame / durationFrames * 100}%`,
    '--music-video-clip-width': `${clip.durationFrames / durationFrames * 100}%`,
  } as CSSProperties
}

function orderedLaneClips(sequence: Sequence, trackId: string | null): SequenceClip[] {
  if (!trackId) return []
  return sequence.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame
      || left.clipId.localeCompare(right.clipId))
}

function currentSpeed(clip: SequenceClip | null): string {
  if (!clip || clip.source.kind !== 'timed') return '1/1'
  const timed = clip as TimedSequenceClip
  return `${timed.speed.numerator}/${timed.speed.denominator}`
}

function sourceHandleFrames(
  clip: SequenceClip,
  asset: MusicVideoAsset | undefined,
  fps: number,
): { before: number; after: number } {
  if (clip.source.kind !== 'timed') {
    return { before: clip.timelineStartFrame, after: Number.MAX_SAFE_INTEGER }
  }
  const timed = clip as TimedSequenceClip
  const speed = timed.speed.numerator / timed.speed.denominator
  const timeBase = timed.source.range.timeBase.numerator
    / timed.source.range.timeBase.denominator
  const sourceStartSeconds = timed.source.range.startTick * timeBase
  const sourceEndSeconds = (
    timed.source.range.startTick + timed.source.range.durationTicks
  ) * timeBase
  const sourceDurationSeconds = asset?.duration ?? sourceEndSeconds
  return {
    before: Math.floor(sourceStartSeconds * fps / speed),
    after: Math.floor(
      Math.max(0, sourceDurationSeconds - sourceEndSeconds) * fps / speed,
    ),
  }
}

function waveformPath(peaks: number[]): string {
  if (peaks.length === 0) return ''
  const maximumSamples = 720
  const step = Math.max(1, Math.ceil(peaks.length / maximumSamples))
  const values: number[] = []
  for (let index = 0; index < peaks.length; index += step) {
    values.push(Math.max(
      ...peaks.slice(index, index + step).map((peak) => Math.abs(peak)),
    ))
  }
  return values.map((peak, index) => {
    const x = values.length === 1 ? 50 : index / (values.length - 1) * 100
    const amplitude = Math.max(2, Math.min(46, peak * 46))
    return `M${x.toFixed(3)} ${50 - amplitude}V${50 + amplitude}`
  }).join('')
}

function setupLimit(setup: MusicVideoSetupState, sequence: Sequence): number {
  if (
    setup.status === 'ready'
    || setup.status === 'applying'
    || setup.status === 'applied'
  ) return setup.timelineLimitFrame
  return Math.max(1, ...sequence.clips.map(clipEnd))
}

export function MusicVideoEditor({
  sequence,
  assets,
  audioArtifactId,
  setup,
  returnFocus,
  onApplySetup,
  onClose,
  onCommit,
  onCreateTrack,
  onRefreshAssets,
  onRestore,
  onReviewSetup,
}: MusicVideoEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<CanonicalSequencePlayerHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [query, setQuery] = useState('')
  const [sourceSelection, setSourceSelection] = useState<string[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null)
  const [trimDraft, setTrimDraft] = useState<TrimDraft | null>(null)
  const [speedDraft, setSpeedDraft] = useState('1/1')
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [undoSteps, setUndoSteps] = useState<RevisionStep[]>([])
  const [redoSteps, setRedoSteps] = useState<RevisionStep[]>([])
  const audioAsset = assets.find((asset) => asset.artifactId === audioArtifactId)
  const mainTrack = sequence.tracks.find((track) =>
    track.kind === 'video' && track.enabled && !track.locked) ?? null
  const laneClips = orderedLaneClips(sequence, mainTrack?.trackId ?? null)
  const selectedClip = laneClips.find((clip) => clip.clipId === selectedClipId) ?? null
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.artifactId, asset])),
    [assets],
  )
  const playbackAssets = useMemo(
    () => assets.flatMap((asset) => asset.mediaUrl
      ? [{ artifactId: asset.artifactId, mediaUrl: asset.mediaUrl }]
      : []),
    [assets],
  )
  const sourceAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return assets.filter((asset) =>
      (asset.type === 'video' || asset.type === 'final')
      && asset.status === 'ready'
      && asset.mediaUrl
      && (
        !normalized
        || asset.label.toLowerCase().includes(normalized)
        || asset.artifactId.toLowerCase().includes(normalized)
      ))
  }, [assets, query])
  const durationFrames = setupLimit(setup, sequence)
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator
  const laneEnd = Math.max(0, ...laneClips.map(clipEnd))
  const overflowFrames = Math.max(0, laneEnd - durationFrames)
  const editorEnabled = setup.status === 'applied' && mainTrack !== null
  const activeTrim = selectedClip
    ? trimDraft?.clipId === selectedClip.clipId
      ? trimDraft
      : {
          clipId: selectedClip.clipId,
          startFrame: selectedClip.timelineStartFrame,
          endFrame: clipEnd(selectedClip),
        }
    : null
  const selectedAsset = selectedClip
    ? assetById.get(selectedClip.source.artifactId)
    : undefined
  const handles = selectedClip
    ? sourceHandleFrames(selectedClip, selectedAsset, fps)
    : { before: 0, after: 0 }
  const trimMinimum = selectedClip
    ? Math.max(0, selectedClip.timelineStartFrame - handles.before)
    : 0
  const trimMaximum = selectedClip
    ? Math.min(durationFrames, clipEnd(selectedClip) + handles.after)
    : durationFrames

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = dialogRef.current
    dialog?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      returnFocus?.focus()
    }
  }, [onClose, returnFocus])

  const runEdit = async (label: string, request: Record<string, unknown>) => {
    if (!editorEnabled || working) return
    setWorking(label)
    setError(null)
    try {
      const committed = await onCommit(request, sequence)
      setUndoSteps((current) => [...current, {
        beforeRevision: committed.beforeRevision,
        afterRevision: committed.sequence.revision,
      }])
      setRedoSteps([])
      setTrimDraft(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const seekTo = (frame: number) => {
    const next = Math.max(0, Math.min(durationFrames - 1, Math.round(frame)))
    setPlayheadFrame(next)
    playerRef.current?.seekTo(next)
  }

  const waveformPointer = (event: PointerEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    seekTo((event.clientX - bounds.left) / Math.max(1, bounds.width) * durationFrames)
  }

  const waveformKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    seekTo(playheadFrame + (event.key === 'ArrowLeft' ? -1 : 1))
  }

  const selectClip = (clip: SequenceClip) => {
    setSelectedClipId(clip.clipId)
    setTrimDraft({
      clipId: clip.clipId,
      startFrame: clip.timelineStartFrame,
      endFrame: clipEnd(clip),
    })
    setSpeedDraft(currentSpeed(clip))
    seekTo(clip.timelineStartFrame)
  }

  const toggleSource = (artifactId: string) => {
    setSourceSelection((current) => current.includes(artifactId)
      ? current.filter((candidate) => candidate !== artifactId)
      : [...current, artifactId])
  }

  const appendSelection = async () => {
    if (!mainTrack || sourceSelection.length === 0) return
    await runEdit('Adding clips', {
      kind: 'append_clips',
      track_id: mainTrack.trackId,
      artifact_ids: sourceSelection,
      timeline_limit_frame: durationFrames,
    })
    setSourceSelection([])
  }

  const reorder = async (clipIds: string[]) => {
    if (!mainTrack) return
    await runEdit('Reordering clips', {
      kind: 'reorder_clips',
      track_id: mainTrack.trackId,
      clip_ids: clipIds,
      timeline_limit_frame: durationFrames,
    })
  }

  const moveSelected = async (offset: -1 | 1) => {
    if (!selectedClip) return
    const index = laneClips.findIndex((clip) => clip.clipId === selectedClip.clipId)
    const destination = index + offset
    if (destination < 0 || destination >= laneClips.length) return
    const order = laneClips.map((clip) => clip.clipId)
    const [moved] = order.splice(index, 1)
    if (!moved) return
    order.splice(destination, 0, moved)
    await reorder(order)
  }

  const dropClip = async (
    event: DragEvent<HTMLButtonElement>,
    targetClipId: string,
  ) => {
    event.preventDefault()
    const sourceClipId = event.dataTransfer.getData('text/plain') || draggedClipId
    if (!sourceClipId || sourceClipId === targetClipId) return
    const order = laneClips.map((clip) => clip.clipId)
    const from = order.indexOf(sourceClipId)
    const target = order.indexOf(targetClipId)
    if (from < 0 || target < 0) return
    const [moved] = order.splice(from, 1)
    if (!moved) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const after = event.clientX >= bounds.left + bounds.width / 2
    const nextTarget = order.indexOf(targetClipId) + (after ? 1 : 0)
    order.splice(nextTarget, 0, moved)
    setDraggedClipId(null)
    await reorder(order)
  }

  const commitTrim = async (
    edge: 'start' | 'end',
    startFrame: number,
    endFrame: number,
  ) => {
    if (!selectedClip || endFrame <= startFrame) return
    if (
      startFrame === selectedClip.timelineStartFrame
      && endFrame === clipEnd(selectedClip)
    ) return
    await runEdit('Trimming clip', {
      kind: 'trim',
      clip_id: selectedClip.clipId,
      timeline_start_frame: startFrame,
      duration_frames: endFrame - startFrame,
      edge,
      ripple: true,
      timeline_limit_frame: durationFrames,
    })
  }

  const splitSelected = async () => {
    if (
      !selectedClip
      || playheadFrame <= selectedClip.timelineStartFrame
      || playheadFrame >= clipEnd(selectedClip)
    ) {
      setError('Place the playhead inside the selected clip before cutting')
      return
    }
    await runEdit('Cutting clip', {
      kind: 'split',
      clip_id: selectedClip.clipId,
      split_frame: playheadFrame,
    })
    setSelectedClipId(null)
  }

  const deleteSelected = async () => {
    if (!selectedClip) return
    await runEdit('Deleting clip', {
      kind: 'delete',
      clip_id: selectedClip.clipId,
      ripple: true,
    })
    setSelectedClipId(null)
  }

  const applySpeed = async () => {
    if (!selectedClip || selectedClip.source.kind !== 'timed') return
    const speed = SPEEDS.find((candidate) => candidate.value === speedDraft)
    if (!speed) return
    const timed = selectedClip as TimedSequenceClip
    await runEdit('Retiming clip', {
      kind: 'speed',
      clip_id: selectedClip.clipId,
      numerator: speed.numerator,
      denominator: speed.denominator,
      reverse: timed.reverse,
      audio_policy: 'mute',
      ripple: true,
      timeline_limit_frame: durationFrames,
    })
  }

  const undo = async () => {
    const step = undoSteps[undoSteps.length - 1]
    if (!step || working) return
    setWorking('Undoing edit')
    setError(null)
    try {
      await onRestore(step.beforeRevision, sequence.revision)
      setUndoSteps((current) => current.slice(0, -1))
      setRedoSteps((current) => [...current, step])
      setSelectedClipId(null)
      setTrimDraft(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const redo = async () => {
    const step = redoSteps[redoSteps.length - 1]
    if (!step || working) return
    setWorking('Redoing edit')
    setError(null)
    try {
      await onRestore(step.afterRevision, sequence.revision)
      setRedoSteps((current) => current.slice(0, -1))
      setUndoSteps((current) => [...current, step])
      setSelectedClipId(null)
      setTrimDraft(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const playerKeyboard = (action: TimelineKeyboardAction, frame: number) => {
    if (action === 'split') void splitSelected()
    if (action === 'delete') void deleteSelected()
    if (action === 'undo') void undo()
    if (action === 'redo') void redo()
    if (action === 'search') searchRef.current?.focus()
    if (action === 'zoom-in') setTimelineZoom((value) => Math.min(4, value + 0.25))
    if (action === 'zoom-out') setTimelineZoom((value) => Math.max(1, value - 0.25))
    if (action === 'mark-in' && selectedClip) {
      const endFrame = activeTrim?.endFrame ?? clipEnd(selectedClip)
      if (frame < endFrame) {
        setTrimDraft({ clipId: selectedClip.clipId, startFrame: frame, endFrame })
        void commitTrim('start', frame, endFrame)
      }
    }
    if (action === 'mark-out' && selectedClip) {
      const startFrame = activeTrim?.startFrame ?? selectedClip.timelineStartFrame
      if (frame > startFrame) {
        setTrimDraft({ clipId: selectedClip.clipId, startFrame, endFrame: frame })
        void commitTrim('end', startFrame, frame)
      }
    }
  }

  const applySetup = async () => {
    if (setup.status !== 'ready' || working) return
    setWorking('Applying soundtrack')
    setError(null)
    try {
      await onApplySetup()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const createTrack = async (kind: 'video' | 'audio') => {
    if (working) return
    setWorking(kind === 'audio' ? 'Creating soundtrack track' : 'Creating main lane')
    setError(null)
    try {
      const nextSequence = await onCreateTrack(kind)
      if (kind === 'audio') await onReviewSetup(nextSequence)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const refreshWaveform = async () => {
    if (working) return
    setWorking('Refreshing waveform')
    setError(null)
    try {
      await onRefreshAssets()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const timelineStyle = {
    '--music-video-timeline-width': `${timelineZoom * 100}%`,
  } as CSSProperties
  const path = waveformPath(audioAsset?.waveform ?? [])

  return createPortal(
    <div
      className="music-video-editor"
      role="dialog"
      aria-modal="true"
      aria-label="Music video editor"
      ref={dialogRef}
      tabIndex={-1}
    >
      <header className="music-video-editor-header">
        <div>
          <span className="music-video-kicker"><AudioWaveform size={15} /> MUSIC VIDEO</span>
          <h1>{audioAsset?.label ?? audioArtifactId}</h1>
          <p>Master soundtrack · {formatTime(durationFrames, fps)} · {fps.toFixed(2)} fps</p>
        </div>
        <div className="music-video-header-actions">
          <button type="button" disabled={Boolean(working) || undoSteps.length === 0} onClick={() => void undo()}>
            <Undo2 size={16} /> Undo
          </button>
          <button type="button" disabled={Boolean(working) || redoSteps.length === 0} onClick={() => void redo()}>
            <Redo2 size={16} /> Redo
          </button>
          <button className="music-video-close" type="button" onClick={onClose} aria-label="Close music video editor">
            <X size={20} />
          </button>
        </div>
      </header>

      <main className="music-video-editor-main">
        <section className="music-video-preview-panel">
          <CanonicalSequencePlayer
            ref={playerRef}
            sequence={sequence}
            assets={playbackAssets}
            onFrameUpdate={setPlayheadFrame}
            onKeyboardAction={playerKeyboard}
          />
          <aside className="music-video-setup-card" data-status={setup.status}>
            <span>MASTER SOUNDTRACK</span>
            {setup.status === 'loading' && <p>Building the exact canonical setup plan…</p>}
            {setup.status === 'needs-audio-track' && (
              <>
                <p>{setup.message}</p>
                <button type="button" disabled={Boolean(working)} onClick={() => void createTrack('audio')}>
                  <Plus size={15} /> Create soundtrack track
                </button>
              </>
            )}
            {(setup.status === 'ready' || setup.status === 'applying') && (
              <>
                <strong>{setup.summary}</strong>
                <p>{setup.operationCount} atomic operations · ends at frame {setup.timelineLimitFrame}</p>
                {setup.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                <button type="button" disabled={Boolean(working)} onClick={() => void applySetup()}>
                  <Check size={15} /> Apply soundtrack
                </button>
              </>
            )}
            {setup.status === 'applied' && (
              <strong className="music-video-applied"><Check size={15} /> Soundtrack applied</strong>
            )}
            {setup.status === 'error' && (
              <>
                <p className="music-video-error">{setup.message}</p>
                <button type="button" disabled={Boolean(working)} onClick={() => void onReviewSetup()}>
                  <RefreshCw size={15} /> Review again
                </button>
              </>
            )}
          </aside>
        </section>

        <section className="music-video-source-panel" aria-label="Current book video sources">
          <header>
            <div>
              <span>SOURCE CLIPS</span>
              <strong>{sourceSelection.length} selected</strong>
            </div>
            <label>
              <Search size={15} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search current book"
              />
            </label>
            <button
              type="button"
              disabled={!editorEnabled || Boolean(working) || sourceSelection.length === 0}
              onClick={() => void appendSelection()}
            >
              <Plus size={15} /> Add selected
            </button>
          </header>
          <div className="music-video-source-list">
            {sourceAssets.map((asset) => {
              const selected = sourceSelection.includes(asset.artifactId)
              return (
                <button
                  type="button"
                  className={selected ? 'selected' : ''}
                  aria-pressed={selected}
                  key={asset.artifactId}
                  onClick={() => toggleSource(asset.artifactId)}
                >
                  {asset.thumbnailUrl || asset.mediaUrl
                    ? <img src={asset.thumbnailUrl ?? asset.mediaUrl ?? ''} alt="" />
                    : <Film size={24} />}
                  <span>{asset.label}</span>
                  <small>{asset.duration ? `${asset.duration.toFixed(1)}s` : asset.type}</small>
                </button>
              )
            })}
            {sourceAssets.length === 0 && <p>No ready video sources match this search.</p>}
          </div>
        </section>

        <section className="music-video-timeline-panel" aria-label="Music video timeline">
          <header>
            <div>
              <span>MAIN VIDEO LANE</span>
              <strong>{mainTrack?.name ?? 'No editable video track'}</strong>
            </div>
            {!mainTrack && (
              <button type="button" disabled={Boolean(working)} onClick={() => void createTrack('video')}>
                <Plus size={15} /> Create main video track
              </button>
            )}
            <div className="music-video-zoom">
              <button type="button" aria-label="Zoom timeline out" onClick={() => setTimelineZoom((value) => Math.max(1, value - 0.25))}>−</button>
              <span>{Math.round(timelineZoom * 100)}%</span>
              <button type="button" aria-label="Zoom timeline in" onClick={() => setTimelineZoom((value) => Math.min(4, value + 0.25))}>+</button>
            </div>
          </header>
          <div className="music-video-timeline-scroll">
            <div className="music-video-timeline" style={timelineStyle}>
              <div className="music-video-ruler" aria-hidden="true">
                {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                  <span key={ratio}>{formatTime(durationFrames * ratio, fps)}</span>
                ))}
              </div>
              <div className="music-video-lane">
                {laneClips.map((clip) => {
                  const asset = assetById.get(clip.source.artifactId)
                  return (
                    <button
                      type="button"
                      className={selectedClip?.clipId === clip.clipId ? 'selected' : ''}
                      style={clipStyle(clip, durationFrames)}
                      key={clip.clipId}
                      draggable={editorEnabled && !working}
                      onClick={() => selectClip(clip)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', clip.clipId)
                        setDraggedClipId(clip.clipId)
                      }}
                      onDragEnd={() => setDraggedClipId(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => void dropClip(event, clip.clipId)}
                      title={`${asset?.label ?? clip.source.artifactId} · frames ${clip.timelineStartFrame}–${clipEnd(clip)}`}
                    >
                      <span>{asset?.label ?? clip.source.artifactId.slice(0, 8)}</span>
                      <small>{clip.durationFrames}f</small>
                    </button>
                  )
                })}
                <i className="music-video-playhead" style={{ left: `${playheadFrame / durationFrames * 100}%` }} />
              </div>
              <button
                type="button"
                className="music-video-waveform"
                role="slider"
                aria-label="Soundtrack waveform playhead"
                aria-valuemin={0}
                aria-valuemax={durationFrames - 1}
                aria-valuenow={playheadFrame}
                onPointerDown={waveformPointer}
                onKeyDown={waveformKey}
              >
                {path
                  ? (
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                      <path d={path} />
                    </svg>
                  )
                  : <span className="music-video-waveform-placeholder">Waveform unavailable</span>}
                <i style={{ left: `${playheadFrame / durationFrames * 100}%` }} />
              </button>
            </div>
          </div>
          <footer>
            <span>F{playheadFrame} · {formatTime(playheadFrame, fps)}</span>
            {overflowFrames > 0 && <strong>{overflowFrames} frames beyond soundtrack</strong>}
            {!path && (
              <button type="button" disabled={Boolean(working)} onClick={() => void refreshWaveform()}>
                <RefreshCw size={14} /> Refresh waveform
              </button>
            )}
          </footer>
        </section>

        <section className="music-video-inspector" aria-label="Selected clip controls">
          {!selectedClip && <p>Select a main-lane clip to trim, cut, delete, reorder, or retime it.</p>}
          {selectedClip && activeTrim && (
            <>
              <header>
                <div>
                  <span>SELECTED CLIP</span>
                  <strong>{selectedAsset?.label ?? selectedClip.source.artifactId}</strong>
                </div>
                <div>
                  <button type="button" disabled={Boolean(working) || laneClips[0]?.clipId === selectedClip.clipId} onClick={() => void moveSelected(-1)}>
                    <ChevronLeft size={15} /> Earlier
                  </button>
                  <button type="button" disabled={Boolean(working) || laneClips[laneClips.length - 1]?.clipId === selectedClip.clipId} onClick={() => void moveSelected(1)}>
                    Later <ChevronRight size={15} />
                  </button>
                </div>
              </header>
              <div className="music-video-trim-controls">
                <label>
                  In · F{activeTrim.startFrame}
                  <input
                    type="range"
                    min={trimMinimum}
                    max={Math.max(trimMinimum, activeTrim.endFrame - 1)}
                    value={activeTrim.startFrame}
                    disabled={Boolean(working)}
                    onChange={(event) => setTrimDraft({
                      clipId: selectedClip.clipId,
                      startFrame: Number(event.target.value),
                      endFrame: activeTrim.endFrame,
                    })}
                    onPointerUp={(event) => void commitTrim(
                      'start',
                      Number(event.currentTarget.value),
                      activeTrim.endFrame,
                    )}
                    onBlur={(event) => void commitTrim(
                      'start',
                      Number(event.currentTarget.value),
                      activeTrim.endFrame,
                    )}
                    onKeyUp={(event) => {
                      if (event.key !== 'Enter') return
                      void commitTrim(
                        'start',
                        Number(event.currentTarget.value),
                        activeTrim.endFrame,
                      )
                    }}
                  />
                </label>
                <label>
                  Out · F{activeTrim.endFrame}
                  <input
                    type="range"
                    min={activeTrim.startFrame + 1}
                    max={Math.max(activeTrim.startFrame + 1, trimMaximum)}
                    value={activeTrim.endFrame}
                    disabled={Boolean(working)}
                    onChange={(event) => setTrimDraft({
                      clipId: selectedClip.clipId,
                      startFrame: activeTrim.startFrame,
                      endFrame: Number(event.target.value),
                    })}
                    onPointerUp={(event) => void commitTrim(
                      'end',
                      activeTrim.startFrame,
                      Number(event.currentTarget.value),
                    )}
                    onBlur={(event) => void commitTrim(
                      'end',
                      activeTrim.startFrame,
                      Number(event.currentTarget.value),
                    )}
                    onKeyUp={(event) => {
                      if (event.key !== 'Enter') return
                      void commitTrim(
                        'end',
                        activeTrim.startFrame,
                        Number(event.currentTarget.value),
                      )
                    }}
                  />
                </label>
              </div>
              <div className="music-video-edit-actions">
                <button type="button" disabled={Boolean(working)} onClick={() => void splitSelected()}>
                  <Scissors size={15} /> Cut at playhead
                </button>
                <button className="danger-button" type="button" disabled={Boolean(working)} onClick={() => void deleteSelected()}>
                  <Trash2 size={15} /> Ripple-delete
                </button>
                <label>
                  <Gauge size={15} /> Speed
                  <select value={speedDraft} disabled={Boolean(working) || selectedClip.source.kind !== 'timed'} onChange={(event) => setSpeedDraft(event.target.value)}>
                    {SPEEDS.map((speed) => <option key={speed.value} value={speed.value}>{speed.label}</option>)}
                  </select>
                </label>
                <button type="button" disabled={Boolean(working) || selectedClip.source.kind !== 'timed'} onClick={() => void applySpeed()}>
                  Apply speed
                </button>
              </div>
            </>
          )}
        </section>
      </main>

      <footer className="music-video-status" aria-live="polite">
        <span>{working ?? 'Space/K play · J/L shuttle · arrows frame · I/O trim marks · S cut · Delete ripple · ⌘Z undo'}</span>
        {error && <strong>{error}</strong>}
      </footer>
    </div>,
    document.body,
  )
}

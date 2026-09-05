import {
  AudioWaveform,
  Check,
  ChevronLeft,
  ChevronRight,
  Film,
  Gauge,
  Maximize2,
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

type MusicVideoAsset = {
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

function sourceFramesAtOneX(clip: SequenceClip, fps: number): number {
  if (clip.source.kind !== 'timed') return clip.durationFrames
  const timed = clip as TimedSequenceClip
  const seconds = timed.source.range.durationTicks
    * timed.source.range.timeBase.numerator
    / timed.source.range.timeBase.denominator
  return Math.max(1, Math.ceil(seconds * fps))
}

function speedLabel(value: string): string {
  const [numerator, denominator] = value.split('/').map(Number)
  if (!numerator || !denominator) return value
  const rate = numerator / denominator
  if (Number.isInteger(rate)) return `${rate}×`
  return `${parseFloat(rate.toFixed(2))}×`
}

function nextLaneClip(
  lane: SequenceClip[],
  clip: SequenceClip,
): SequenceClip | undefined {
  const index = lane.findIndex((candidate) => candidate.clipId === clip.clipId)
  return index >= 0 ? lane[index + 1] : undefined
}

function clipSlideRoom(
  clip: SequenceClip,
  lane: SequenceClip[],
  limit: number,
): { left: number; right: number } {
  const index = lane.findIndex((candidate) => candidate.clipId === clip.clipId)
  const previous = index > 0 ? lane[index - 1] : undefined
  const next = index >= 0 ? lane[index + 1] : undefined
  return {
    left: clip.timelineStartFrame - (previous ? clipEnd(previous) : 0),
    right: (next ? next.timelineStartFrame : limit) - clipEnd(clip),
  }
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

function isImageMediaUrl(url: string): boolean {
  return /\.(avif|bmp|gif|jpe?g|png|webp)(?:$|\?)/i.test(url)
}

function SourceThumb({ asset }: { asset: MusicVideoAsset }) {
  const imageUrl = asset.thumbnailUrl
    ?? (asset.mediaUrl && isImageMediaUrl(asset.mediaUrl) ? asset.mediaUrl : null)
  if (imageUrl) return <img src={imageUrl} alt="" />
  if (asset.mediaUrl) {
    return (
      <video
        src={asset.mediaUrl}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          if (video.duration > 0) {
            video.currentTime = Math.min(0.12, video.duration * 0.15)
          }
        }}
      />
    )
  }
  return <Film size={24} />
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
  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [query, setQuery] = useState('')
  const [sourceSelection, setSourceSelection] = useState<string[]>([])
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null)
  const [trimDraft, setTrimDraft] = useState<TrimDraft | null>(null)
  const [speedDraft, setSpeedDraft] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [undoSteps, setUndoSteps] = useState<RevisionStep[]>([])
  const [redoSteps, setRedoSteps] = useState<RevisionStep[]>([])
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null)
  const [waveformWait, setWaveformWait] = useState(false)
  const audioAsset = assets.find((asset) => asset.artifactId === audioArtifactId)
  const audioAssetRef = useRef(audioAsset)
  const refreshAssetsRef = useRef(onRefreshAssets)
  useEffect(() => {
    audioAssetRef.current = audioAsset
  }, [audioAsset])
  useEffect(() => {
    refreshAssetsRef.current = onRefreshAssets
  }, [onRefreshAssets])
  const mainTrack = sequence.tracks.find((track) =>
    track.kind === 'video' && track.enabled && !track.locked) ?? null
  const laneClips = orderedLaneClips(sequence, mainTrack?.trackId ?? null)
  const selectedClip = laneClips.find((clip) => clip.clipId === selectedClipId) ?? null
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.artifactId, asset])),
    [assets],
  )
  const previewAsset = previewSourceId
    ? assetById.get(previewSourceId)
    : undefined
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
  const editorEnabled = (
    setup.status === 'ready' || setup.status === 'applied'
  ) && mainTrack !== null
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
  const selectedIndex = selectedClip
    ? laneClips.findIndex((clip) => clip.clipId === selectedClip.clipId)
    : -1
  const stretchEnd = selectedClip
    ? (nextLaneClip(laneClips, selectedClip)?.timelineStartFrame ?? durationFrames)
    : durationFrames
  const slideRoom = selectedClip
    ? clipSlideRoom(selectedClip, laneClips, durationFrames)
    : { left: 0, right: 0 }
  const canReorderEarlier = selectedIndex > 0
  const canReorderLater = selectedIndex >= 0 && selectedIndex < laneClips.length - 1
  const canMoveEarlier = canReorderEarlier || slideRoom.left > 0
  const canMoveLater = canReorderLater || slideRoom.right > 0
  const canStretch = Boolean(selectedClip && stretchEnd > clipEnd(selectedClip))
  const trimMinimum = selectedClip
    ? Math.max(0, selectedClip.timelineStartFrame - handles.before)
    : 0
  const trimMaximum = selectedClip
    ? Math.min(
      durationFrames,
      Math.max(clipEnd(selectedClip) + handles.after, stretchEnd),
    )
    : durationFrames
  const selectedSpeed = currentSpeed(selectedClip)
  const speedOptions: Array<{ label: string; value: string }> = SPEEDS.some(
    (speed) => speed.value === selectedSpeed,
  )
    ? [...SPEEDS]
    : [{ label: speedLabel(selectedSpeed), value: selectedSpeed }, ...SPEEDS]

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = dialogRef.current
    const focusTarget = dialog?.querySelector<HTMLElement>('.canonical-player') ?? dialog
    focusTarget?.focus()
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

  useEffect(() => {
    if ((audioAssetRef.current?.waveform?.length ?? 0) > 0) return
    let cancelled = false
    setWaveformWait(true)
    const poll = async () => {
      for (let attempt = 0; attempt < 24 && !cancelled; attempt += 1) {
        try {
          await refreshAssetsRef.current()
        } catch {
          break
        }
        if ((audioAssetRef.current?.waveform?.length ?? 0) > 0) break
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
      if (!cancelled) setWaveformWait(false)
    }
    void poll()
    return () => {
      cancelled = true
    }
  }, [audioArtifactId])

  const runEdit = async (label: string, request: Record<string, unknown>) => {
    if (working) return
    if (!mainTrack) {
      setError('Create a main video track before editing clips')
      return
    }
    if (setup.status !== 'ready' && setup.status !== 'applied') {
      setError('Wait for the soundtrack duration before editing clips')
      return
    }
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
      setSpeedDraft(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWorking(null)
    }
  }

  const seekTo = (frame: number) => {
    const next = Math.max(0, Math.min(durationFrames - 1, Math.round(frame)))
    setPreviewSourceId(null)
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
    setPreviewSourceId(null)
    setSelectedClipId(clip.clipId)
    setTrimDraft({
      clipId: clip.clipId,
      startFrame: clip.timelineStartFrame,
      endFrame: clipEnd(clip),
    })
    setSpeedDraft(null)
    seekTo(clip.timelineStartFrame)
  }

  const toggleSource = (artifactId: string) => {
    setPreviewSourceId(artifactId)
    setSelectedClipId(null)
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
    setPreviewSourceId(null)
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
    if (!selectedClip || !mainTrack) return
    const index = laneClips.findIndex((clip) => clip.clipId === selectedClip.clipId)
    const destination = index + offset
    if (destination >= 0 && destination < laneClips.length) {
      const order = laneClips.map((clip) => clip.clipId)
      const [moved] = order.splice(index, 1)
      if (!moved) return
      order.splice(destination, 0, moved)
      await reorder(order)
      return
    }
    const room = clipSlideRoom(selectedClip, laneClips, durationFrames)
    const nudge = Math.max(1, Math.round(fps))
    const delta = offset < 0
      ? -Math.min(nudge, room.left)
      : Math.min(nudge, room.right)
    if (delta === 0) return
    await runEdit('Moving clip', {
      kind: 'move',
      clip_id: selectedClip.clipId,
      track_id: mainTrack.trackId,
      timeline_start_frame: selectedClip.timelineStartFrame + delta,
    })
  }

  const stretchSelected = async () => {
    if (!selectedClip || stretchEnd <= clipEnd(selectedClip)) return
    const target = stretchEnd - selectedClip.timelineStartFrame
    if (selectedClip.source.kind !== 'timed') {
      await runEdit('Stretching clip', {
        kind: 'trim',
        clip_id: selectedClip.clipId,
        timeline_start_frame: selectedClip.timelineStartFrame,
        duration_frames: target,
        edge: 'end',
        ripple: true,
        timeline_limit_frame: durationFrames,
      })
      return
    }
    const timed = selectedClip as TimedSequenceClip
    const native = sourceFramesAtOneX(selectedClip, fps)
    await runEdit('Stretching clip', {
      kind: 'speed',
      clip_id: selectedClip.clipId,
      numerator: native,
      denominator: target,
      reverse: timed.reverse,
      audio_policy: 'mute',
      ripple: true,
      timeline_limit_frame: durationFrames,
    })
  }

  const dropOnLane = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!mainTrack) return
    const sourceClipId = event.dataTransfer.getData('text/plain') || draggedClipId
    const clip = laneClips.find((candidate) => candidate.clipId === sourceClipId)
    if (!clip) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const frame = Math.round(
      (event.clientX - bounds.left) / Math.max(1, bounds.width) * durationFrames,
    )
    const room = clipSlideRoom(clip, laneClips, durationFrames)
    const minStart = clip.timelineStartFrame - room.left
    const maxStart = clip.timelineStartFrame + room.right
    const nextStart = Math.max(minStart, Math.min(maxStart, frame))
    setDraggedClipId(null)
    if (nextStart === clip.timelineStartFrame) return
    await runEdit('Moving clip', {
      kind: 'move',
      clip_id: clip.clipId,
      track_id: mainTrack.trackId,
      timeline_start_frame: nextStart,
    })
  }

  const dropClip = async (
    event: DragEvent<HTMLElement>,
    targetClipId: string,
  ) => {
    event.preventDefault()
    event.stopPropagation()
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
    if (
      edge === 'end'
      && selectedClip.source.kind === 'timed'
      && endFrame > clipEnd(selectedClip) + handles.after
    ) {
      const timed = selectedClip as TimedSequenceClip
      const target = endFrame - selectedClip.timelineStartFrame
      await runEdit('Stretching clip', {
        kind: 'speed',
        clip_id: selectedClip.clipId,
        numerator: sourceFramesAtOneX(selectedClip, fps),
        denominator: target,
        reverse: timed.reverse,
        audio_policy: 'mute',
        ripple: true,
        timeline_limit_frame: durationFrames,
      })
      return
    }
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
    const value = speedDraft ?? selectedSpeed
    const preset = SPEEDS.find((candidate) => candidate.value === value)
    const [numerator, denominator] = value.split('/').map(Number)
    const speed = preset ?? (
      numerator && denominator
        ? { numerator, denominator }
        : null
    )
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
    setWaveformWait(true)
    setError(null)
    try {
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await onRefreshAssets()
        if ((audioAssetRef.current?.waveform?.length ?? 0) > 0) return
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }
      setError('Soundtrack waveform is still processing. Try refresh again in a moment.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setWaveformWait(false)
      setWorking(null)
    }
  }

  const dialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], .canonical-player')) return
    if (playerRef.current) {
      playerRef.current.handleKeyDown(event)
      return
    }
    const preview = previewVideoRef.current
    const key = event.key.toLowerCase()
    if (!preview || (key !== ' ' && key !== 'k')) return
    event.preventDefault()
    if (preview.paused) void preview.play().catch(() => undefined)
    else preview.pause()
  }

  const timelineStyle = {
    '--music-video-timeline-width': `${timelineZoom * 100}%`,
  } as CSSProperties
  const path = waveformPath(audioAsset?.waveform ?? [])
  const rulerSegments = Math.max(4, Math.round(timelineZoom * 4))
  const rulerMarks = Array.from(
    { length: rulerSegments + 1 },
    (_, index) => index / rulerSegments,
  )
  const clipActionsDisabled = !editorEnabled || Boolean(working)

  return createPortal(
    <div
      className="music-video-editor"
      role="dialog"
      aria-modal="true"
      aria-label="Music video editor"
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={dialogKeyDown}
    >
      <header className="music-video-editor-header">
        <div className="music-video-title">
          <span className="music-video-kicker"><AudioWaveform size={14} /> MUSIC VIDEO</span>
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
        <section className="music-video-source-panel" aria-label="Current book video sources">
          <header>
            <div className="music-video-panel-title">
              <span>SOURCE CLIPS</span>
              <strong>{sourceSelection.length} of {sourceAssets.length} selected</strong>
            </div>
          </header>
          <label className="music-video-search">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search current book"
              aria-label="Search source clips"
            />
          </label>
          <div className="music-video-source-list">
            {sourceAssets.map((asset) => {
              const selected = sourceSelection.includes(asset.artifactId)
              const previewing = previewSourceId === asset.artifactId
              return (
                <button
                  type="button"
                  className={[
                    selected ? 'selected' : '',
                    previewing ? 'previewing' : '',
                  ].filter(Boolean).join(' ')}
                  aria-pressed={selected}
                  aria-label={asset.label}
                  key={asset.artifactId}
                  onClick={() => toggleSource(asset.artifactId)}
                >
                  <span className="music-video-source-thumb">
                    <SourceThumb asset={asset} />
                    {selected && <i><Check size={12} /></i>}
                  </span>
                  <span>{asset.label}</span>
                  <small>{asset.duration ? `${asset.duration.toFixed(1)}s` : asset.type}</small>
                </button>
              )
            })}
            {sourceAssets.length === 0 && <p>No ready video sources match this search.</p>}
          </div>
          <button
            type="button"
            className="music-video-add-selected"
            disabled={!editorEnabled || Boolean(working) || sourceSelection.length === 0}
            onClick={() => void appendSelection()}
          >
            <Plus size={15} /> Add selected
          </button>
        </section>

        <section className="music-video-preview-panel" aria-label="Program monitor">
          {previewAsset?.mediaUrl ? (
            <div className="music-video-source-preview">
              <video
                key={previewAsset.artifactId}
                ref={previewVideoRef}
                src={previewAsset.mediaUrl}
                controls
                autoPlay
                muted
                playsInline
              />
              <p>
                <span>Previewing source · {previewAsset.label}</span>
                <button type="button" onClick={() => setPreviewSourceId(null)}>
                  Show sequence
                </button>
              </p>
            </div>
          ) : (
            <CanonicalSequencePlayer
              ref={playerRef}
              sequence={sequence}
              assets={playbackAssets}
              onFrameUpdate={setPlayheadFrame}
              onKeyboardAction={playerKeyboard}
            />
          )}
        </section>

        <section className="music-video-inspector" aria-label="Selected clip controls">
          <aside className="music-video-setup-card" data-status={setup.status}>
            <span><AudioWaveform size={13} /> MASTER SOUNDTRACK</span>
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
                  <AudioWaveform size={15} /> Apply soundtrack
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

          <div className="music-video-clip-panel">
            {!selectedClip && (
              <div className="music-video-inspector-empty">
                <span className="music-video-kicker">SELECTED CLIP</span>
                <p>Select a main-lane clip to trim, cut, delete, move, or stretch it.</p>
                {laneClips.length === 0 && (
                  <p>Pick source clips on the left and press Add selected to fill the lane.</p>
                )}
              </div>
            )}
            {selectedClip && activeTrim && (
              <>
                <header>
                  <span className="music-video-kicker">SELECTED CLIP</span>
                  <strong>{selectedAsset?.label ?? selectedClip.source.artifactId}</strong>
                  <p>
                    {formatTime(selectedClip.durationFrames, fps)}
                    {' · '}F{selectedClip.timelineStartFrame}–F{clipEnd(selectedClip)}
                    {' · '}{speedLabel(selectedSpeed)}
                    {' · '}clip {selectedIndex + 1} of {laneClips.length}
                  </p>
                </header>
                <div className="music-video-trim-controls">
                  <label>
                    <span>In <em>F{activeTrim.startFrame} · {formatTime(activeTrim.startFrame, fps)}</em></span>
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
                    <span>Out <em>F{activeTrim.endFrame} · {formatTime(activeTrim.endFrame, fps)}</em></span>
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
                  <button className="danger-button" type="button" disabled={clipActionsDisabled} onClick={() => void deleteSelected()}>
                    <Trash2 size={15} /> Delete clip
                  </button>
                  <button type="button" disabled={clipActionsDisabled || !canMoveEarlier} onClick={() => void moveSelected(-1)}>
                    <ChevronLeft size={15} /> Move earlier
                  </button>
                  <button type="button" disabled={clipActionsDisabled || !canMoveLater} onClick={() => void moveSelected(1)}>
                    Move later <ChevronRight size={15} />
                  </button>
                  <button className="music-video-span" type="button" disabled={clipActionsDisabled || !canStretch} onClick={() => void stretchSelected()}>
                    <Maximize2 size={15} /> Stretch to fill
                  </button>
                  <label>
                    <Gauge size={15} /> Speed
                    <select value={speedDraft ?? selectedSpeed} disabled={Boolean(working) || selectedClip.source.kind !== 'timed'} onChange={(event) => setSpeedDraft(event.target.value)}>
                      {speedOptions.map((speed) => <option key={speed.value} value={speed.value}>{speed.label}</option>)}
                    </select>
                  </label>
                  <button type="button" disabled={Boolean(working) || selectedClip.source.kind !== 'timed'} onClick={() => void applySpeed()}>
                    Apply speed
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="music-video-timeline-panel" aria-label="Music video timeline">
          <header>
            <div className="music-video-panel-title">
              <span>MAIN VIDEO LANE</span>
              <strong>{mainTrack?.name ?? 'No editable video track'}</strong>
            </div>
            {!mainTrack && (
              <button type="button" disabled={Boolean(working)} onClick={() => void createTrack('video')}>
                <Plus size={15} /> Create main video track
              </button>
            )}
            <span className="music-video-playhead-readout">F{playheadFrame} · {formatTime(playheadFrame, fps)}</span>
            <div className="music-video-zoom">
              <button type="button" aria-label="Zoom timeline out" onClick={() => setTimelineZoom((value) => Math.max(1, value - 0.25))}>−</button>
              <span>{Math.round(timelineZoom * 100)}%</span>
              <button type="button" aria-label="Zoom timeline in" onClick={() => setTimelineZoom((value) => Math.min(4, value + 0.25))}>+</button>
            </div>
          </header>
          <div className="music-video-timeline-scroll">
            <div className="music-video-timeline" style={timelineStyle}>
              <div className="music-video-ruler" aria-hidden="true">
                {rulerMarks.map((ratio) => (
                  <span key={ratio}>{formatTime(durationFrames * ratio, fps)}</span>
                ))}
              </div>
              <div
                className="music-video-lane"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void dropOnLane(event)}
              >
                {laneClips.map((clip) => {
                  const asset = assetById.get(clip.source.artifactId)
                  const selected = selectedClip?.clipId === clip.clipId
                  return (
                    <div
                      className={selected ? 'music-video-clip selected' : 'music-video-clip'}
                      style={clipStyle(clip, durationFrames)}
                      key={clip.clipId}
                      onClick={() => selectClip(clip)}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onDrop={(event) => void dropClip(event, clip.clipId)}
                    >
                      <button
                        type="button"
                        className="music-video-clip-hit"
                        draggable={editorEnabled && !working}
                        onClick={() => selectClip(clip)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', clip.clipId)
                          setDraggedClipId(clip.clipId)
                        }}
                        onDragEnd={() => setDraggedClipId(null)}
                        title={`${asset?.label ?? clip.source.artifactId} · ${formatTime(clip.durationFrames, fps)} · frames ${clip.timelineStartFrame}–${clipEnd(clip)}`}
                      >
                        <span>{asset?.label ?? clip.source.artifactId.slice(0, 8)}</span>
                        <small>{formatTime(clip.durationFrames, fps)}</small>
                      </button>
                      {selected && (
                        <div className="music-video-clip-actions">
                          <button
                            type="button"
                            aria-label="Move clip earlier"
                            disabled={clipActionsDisabled || !canMoveEarlier}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              void moveSelected(-1)
                            }}
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label="Cut clip at playhead"
                            disabled={clipActionsDisabled}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              void splitSelected()
                            }}
                          >
                            <Scissors size={14} />
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            aria-label="Delete clip"
                            disabled={clipActionsDisabled}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteSelected()
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label="Move clip later"
                            disabled={clipActionsDisabled || !canMoveLater}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              void moveSelected(1)
                            }}
                          >
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      )}
                    </div>
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
                  : (
                    <span className="music-video-waveform-placeholder">
                      {waveformWait
                        ? 'Loading soundtrack waveform…'
                        : 'Waveform unavailable'}
                    </span>
                  )}
                <i style={{ left: `${playheadFrame / durationFrames * 100}%` }} />
              </button>
            </div>
          </div>
          {(overflowFrames > 0 || !path) && (
            <footer>
              {overflowFrames > 0 && <strong>{overflowFrames} frames beyond soundtrack</strong>}
              {!path && (
                <button type="button" disabled={Boolean(working)} onClick={() => void refreshWaveform()}>
                  <RefreshCw size={14} /> Refresh waveform
                </button>
              )}
            </footer>
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

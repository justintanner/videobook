import {
  AudioWaveform,
  Check,
  Download,
  Film,
  PanelsTopLeft,
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import {
  useEffect,
  useCallback,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { Sequence, SequenceClip, TimedSequenceClip } from 'videobook-engine'
import { initialMusicDockView, type MusicLibraryTab } from '@/videobook/composer-dock'
import { formatTimecode } from '@/videobook/timecode'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import { NotebookTimeline, type NotebookTimelineProps } from './NotebookTimeline'
import { MusicRhythmControls } from './MusicRhythmControls'
import { MusicDraftControls } from './MusicDraftControls'
import { MusicVideoClipInspector, type ClipFit } from './MusicVideoClipInspector'
import { MusicVideoTransport, SegmentedControl, type SegmentedOption } from './MusicVideoPanels'
import type { MusicDraftOptions, MusicVideoDraft } from '../../../server/src/rhythm/draft-model'
import type { useMusicRhythm } from '@/videobook/useMusicRhythm'
import { nearestBeat } from '../../../server/src/rhythm/timing'
import './TimelinePreview.css'
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
  | { status: 'timeline' }
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
  assembly: NotebookTimelineProps['assembly']
  rhythm: ReturnType<typeof useMusicRhythm>
  address?: string
  initialFrame?: number
  onFrameUpdate: (frame: number) => void
  onExport: () => void
  onPlanDraft: (options: MusicDraftOptions, sequence: Sequence) => Promise<MusicVideoDraft>
  onApplyDraft: (draft: MusicVideoDraft) => Promise<MusicVideoCommitResult>

  sequence: Sequence
  assets: MusicVideoAsset[]
  audioArtifactId?: string
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
  { label: '0.5×', value: '1/2', numerator: 1, denominator: 2 },
  { label: '0.75×', value: '3/4', numerator: 3, denominator: 4 },
  { label: '1×', value: '1/1', numerator: 1, denominator: 1 },
  { label: '1.5×', value: '3/2', numerator: 3, denominator: 2 },
  { label: '2×', value: '2/1', numerator: 2, denominator: 1 },
] as const

const LIBRARY_TABS: readonly { value: MusicLibraryTab; label: string }[] = [
  { value: 'media', label: 'Media' },
  { value: 'music', label: 'Music' },
  { value: 'autocut', label: 'Auto-cut' },
]

type SnapMode = 'off' | 'beats' | 'bars'

const TIMELINE_HEIGHT_MIN = 20
const TIMELINE_HEIGHT_MAX = 60

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))
}

function clipEnd(clip: SequenceClip): number {
  return clip.timelineStartFrame + clip.durationFrames
}

const formatTime = formatTimecode

function clampTimelineHeight(value: number): number {
  return Math.max(TIMELINE_HEIGHT_MIN, Math.min(TIMELINE_HEIGHT_MAX, Math.round(value)))
}

function neighbourBeats(markers: readonly { frame: number }[], frame: number): { previous: number | null; next: number | null } {
  const previous = [...markers].reverse().find((marker) => marker.frame < frame)
  const next = markers.find((marker) => marker.frame > frame)
  return { previous: previous?.frame ?? null, next: next?.frame ?? null }
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
  const before = Math.floor(sourceStartSeconds * fps / speed)
  const after = Math.floor(Math.max(0, sourceDurationSeconds - sourceEndSeconds) * fps / speed)
  return timed.reverse ? { before: after, after: before } : { before, after }
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
  assembly,
  rhythm,
  address,
  initialFrame = 0,
  onFrameUpdate,
  onExport,
  onPlanDraft,
  onApplyDraft,
  onApplySetup,
  onClose,
  onCommit,
  onCreateTrack,
  onRefreshAssets,
  onRestore,
  onReviewSetup,
}: MusicVideoEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeDialog = useEffectEvent(onClose)
  const [toolsOpen, setToolsOpen] = useState(setup.status !== 'timeline')
  const [timelineHeight, setTimelineHeight] = useState(34)
  const [snapChoice, setSnapChoice] = useState<{ mode: SnapMode; fallback: SnapMode }>({ mode: 'beats', fallback: 'off' })
  const [correctionsOpen, setCorrectionsOpen] = useState(false)
  const playerRef = useRef<CanonicalSequencePlayerHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previewVideoRef = useRef<HTMLVideoElement>(null)
  const [playheadFrame, setPlayheadFrame] = useState(initialFrame)
  const updateFrame = useCallback((frame: number) => { setPlayheadFrame(frame); onFrameUpdate(frame) }, [onFrameUpdate])
  const [draft, setDraft] = useState<MusicVideoDraft | null>(null)
  const [query, setQuery] = useState('')
  const [sourceSelection, setSourceSelection] = useState<string[]>([])
  const selectedClipId = assembly.selectedClipId
  const setSelectedClipId = assembly.selectClip
  const [trimDraft, setTrimDraft] = useState<TrimDraft | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoSteps, setUndoSteps] = useState<RevisionStep[]>([])
  const [redoSteps, setRedoSteps] = useState<RevisionStep[]>([])
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null)
  const [libraryTab, setLibraryTab] = useState<MusicLibraryTab>(
    () => initialMusicDockView(setup.status),
  )
  const audioAsset = assets.find((asset) => asset.artifactId === (rhythm.master?.source.artifactId ?? audioArtifactId))
  const mainTrack = [...sequence.tracks].sort((a, b) => a.ordinal - b.ordinal).find((track) => track.kind === 'video') ?? null
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
  const durationFrames = rhythm.master ? rhythm.master.timelineStartFrame + rhythm.master.durationFrames : setupLimit(setup, sequence)
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator
  const laneEnd = Math.max(0, ...laneClips.map(clipEnd))
  const overflowFrames = Math.max(0, laneEnd - durationFrames)
  const editorEnabled = (
    setup.status === 'ready' || setup.status === 'applied' || setup.status === 'timeline'
  ) && mainTrack !== null && mainTrack.enabled && !mainTrack.locked
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
      clipEnd(selectedClip) + handles.after,
    )
    : durationFrames
  const selectedSpeed = currentSpeed(selectedClip)
  const speedOptions: SegmentedOption<string>[] = SPEEDS.some(
    (speed) => speed.value === selectedSpeed,
  )
    ? [...SPEEDS]
    : [{ label: speedLabel(selectedSpeed), value: selectedSpeed }, ...SPEEDS]
  const beats = neighbourBeats(rhythm.mapped, playheadFrame)
  const hasBeats = rhythm.mapped.length > 0
  const hasBars = rhythm.mapped.some((marker) => marker.bar)
  const analysisPending = rhythm.status === 'queued' || rhythm.status === 'analyzing'
  const requestedSnap = snapChoice.mode === 'bars' && !hasBars ? snapChoice.fallback : snapChoice.mode
  const snap = requestedSnap === 'beats' && !hasBeats || requestedSnap === 'bars' && !hasBars ? 'off' : requestedSnap
  const snapOptions: SegmentedOption<SnapMode>[] = [
    { value: 'off', label: 'Off' },
    { value: 'beats', label: 'Beats', disabled: !hasBeats, title: hasBeats ? 'Snap edits to beats' : 'Analyze beats or set a beat grid first' },
    { value: 'bars', label: 'Bars', disabled: !hasBeats, title: hasBars ? 'Snap edits to bar starts' : 'Set up bar starts to enable bar snapping' },
  ]

  function openRhythmSettings(mode: SnapMode = 'beats') {
    setSelectedClipId(null)
    setToolsOpen(true)
    setLibraryTab('music')
    if (mode === 'beats') setCorrectionsOpen(Boolean(rhythm.master))
    setSnapChoice({ mode, fallback: snap })
    if (mode === 'bars') requestAnimationFrame(() => {
      const input = dialogRef.current?.querySelector<HTMLInputElement>('input[name="beats-per-bar"]')
      input?.focus()
      input?.scrollIntoView({ block: 'nearest' })
    })
  }

  function chooseSnap(mode: SnapMode) {
    if (mode === 'bars' && !hasBars) {
      openRhythmSettings(mode)
      return
    }
    setSnapChoice({ mode, fallback: 'off' })
  }

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    dialog?.querySelector<HTMLButtonElement>('.music-video-close')?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || !(event.target instanceof Element) || event.target.closest('dialog') !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDialog()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = focusableElements(dialog)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      dialog?.close()
      restoreFocusElement(returnFocus)
    }
  }, [returnFocus])

  const runEdit = async (label: string, request: Record<string, unknown>) => {
    if (working || draft) return false
    if (!mainTrack) {
      setError('Create a main video track before editing clips')
      return false
    }
    if (setup.status !== 'ready' && setup.status !== 'applied' && setup.status !== 'timeline') {
      setError('Wait for the soundtrack duration before editing clips')
      return false
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
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return false
    } finally {
      setWorking(null)
    }
  }

  const seekTo = (frame: number) => {
    const next = Math.max(0, Math.min(Math.max(durationFrames, ...sequence.clips.map(clipEnd)) - 1, Math.round(frame)))
    setPreviewSourceId(null)
    updateFrame(next)
    playerRef.current?.seekTo(next)
  }

  const selectClip = (clip: SequenceClip) => {
    setPreviewSourceId(null)
    setSelectedClipId(clip.clipId)
    if (sequence.tracks.find((track) => track.trackId === clip.trackId)?.kind === 'audio') setLibraryTab('music')
    setTrimDraft({
      clipId: clip.clipId,
      startFrame: clip.timelineStartFrame,
      endFrame: clipEnd(clip),
    })
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
    const committed = await runEdit('Adding clips', {
      kind: 'append_clips',
      track_id: mainTrack.trackId,
      artifact_ids: sourceSelection,
      timeline_limit_frame: rhythm.master ? durationFrames : Math.max(durationFrames, laneEnd + sourceSelection.reduce((sum, id) => sum + Math.ceil((assetById.get(id)?.duration ?? 0) * fps), 0)),
      fit: 'source', visual_fit: 'fit',
    })
    if (!committed) return
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
        ripple: false,
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
      ripple: false,
      timeline_limit_frame: durationFrames,
    })
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
    if (snap !== 'off') {
      if (edge === 'start') startFrame = nearestBeat(startFrame, rhythm.mapped, snap)
      else endFrame = nearestBeat(endFrame, rhythm.mapped, snap)
    }
    if (endFrame <= startFrame) { setError('Choose distinct beat boundaries or turn snapping off'); return }
    await runEdit('Trimming clip', {
      kind: 'trim',
      clip_id: selectedClip.clipId,
      timeline_start_frame: startFrame,
      duration_frames: endFrame - startFrame,
      edge,
      ripple: false,
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
    const cutFrame = nearestBeat(playheadFrame, rhythm.mapped, snap)
    if (cutFrame <= selectedClip.timelineStartFrame || cutFrame >= clipEnd(selectedClip)) {
      setError('Choose a beat inside the selected clip, or turn snapping off')
      return
    }
    await runEdit('Cutting clip', {
      kind: 'split',
      clip_id: selectedClip.clipId,
      split_frame: cutFrame,
    })
    setSelectedClipId(null)
  }

  const deleteSelected = async () => {
    if (!selectedClip) return
    await runEdit('Deleting clip', {
      kind: 'delete',
      clip_id: selectedClip.clipId,
      ripple: false,
    })
    setSelectedClipId(null)
  }

  const applySpeed = async (value: string) => {
    if (!selectedClip || selectedClip.source.kind !== 'timed') return
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
      ripple: false,
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
    if (action === 'search') {
      setToolsOpen(true)
      setLibraryTab('media')
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    if (action === 'zoom-in') dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Zoom timeline in"]')?.click()
    if (action === 'zoom-out') dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Zoom timeline out"]')?.click()
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

  const dialogKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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

  const makeDraft = async (options: MusicDraftOptions) => {
    if (working) return
    setWorking('Planning draft')
    setError(null)
    playerRef.current?.pause()
    try {
      const result = await onPlanDraft(options, sequence)
      setDraft(result)
      setPreviewSourceId(null)
      seekTo(options.start_frame)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setWorking(null) }
  }
  const applyDraft = async () => {
    if (!draft || working || draft.uncovered.length) return
    setWorking('Applying draft')
    setError(null)
    playerRef.current?.pause()
    try {
      const committed = await onApplyDraft(draft)
      setUndoSteps((current) => [...current, { beforeRevision: committed.beforeRevision, afterRevision: committed.sequence.revision }])
      setRedoSteps([])
      setDraft(null)
      setSelectedClipId(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setWorking(null) }
  }
  const clipActionsDisabled = !editorEnabled || Boolean(working) || Boolean(draft)

  const resizeTimeline = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: globalThis.PointerEvent) => {
      setTimelineHeight(clampTimelineHeight((window.innerHeight - moveEvent.clientY) / window.innerHeight * 100))
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }
  const resizeTimelineByKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowUp' ? 2 : event.key === 'ArrowDown' ? -2 : 0
    if (!step) return
    event.preventDefault()
    event.stopPropagation()
    setTimelineHeight((current) => clampTimelineHeight(current + step))
  }
  const discardDraft = () => { playerRef.current?.pause(); setDraft(null) }
  const selectedSources = sourceSelection.flatMap((id) => { const asset = assetById.get(id); return asset ? [asset] : [] })
  const beatStatus = analysisPending
    ? 'Analyzing beats…'
    : hasBeats ? `${rhythm.mapped.length} beats${rhythm.analysis?.lowConfidence && !rhythm.rhythm.settings.correction ? ' · Review timing' : ''}${hasBars ? '' : ' · Bars not set'}`
      : rhythm.status === 'no-beats' ? 'Analysis complete · No reliable beats found · Set a beat grid'
        : rhythm.master ? 'Analyze the soundtrack to enable snapping' : 'Choose a soundtrack for snapping'

  return createPortal(
    <dialog
      className="music-video-editor timeline-preview-fullscreen"
      aria-label={address ? `Timeline preview ${address}` : 'Music video editor'}
      style={{ '--music-timeline-height': `${timelineHeight}dvh` } as CSSProperties}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      ref={dialogRef}
      tabIndex={-1}
      onKeyDown={dialogKeyDown}
    >
      <header className="music-video-editor-header">
        <button className="music-video-close mv-icon" type="button" onClick={onClose} aria-label={address ? 'Close timeline preview' : 'Close music video editor'}>
          <X size={20} />
        </button>
        <div className="music-video-title">
          <h1>
            {address ? <>Timeline <code>{address}</code></> : audioAsset?.label ?? 'Music video'}
            {draft && <span className="mv-draft-badge">Draft preview</span>}
          </h1>
          <p>{sequence.width}×{sequence.height} · {parseFloat(fps.toFixed(2))} fps · {formatTime(durationFrames, fps)}</p>
        </div>
        <div className="music-video-header-actions">
          <button type="button" className="mv-quiet mv-tools-toggle" aria-pressed={toolsOpen} aria-label={toolsOpen ? 'Hide tools' : 'Show tools'} onClick={() => setToolsOpen((open) => !open)}>
            <PanelsTopLeft size={16} /> <span>{toolsOpen ? 'Hide tools' : 'Show tools'}</span>
          </button>
          {draft ? <>
            <span className="mv-draft-note">Nothing changes until you apply.</span>
            <button type="button" disabled={Boolean(working)} onClick={discardDraft}>Discard draft</button>
            <button type="button" className="mv-apply" disabled={Boolean(working) || draft.uncovered.length > 0} onClick={() => void applyDraft()}>
              <Check size={16} /> Apply draft
            </button>
          </> : <>
            <button type="button" className="mv-quiet" disabled={Boolean(working) || undoSteps.length === 0} onClick={() => void undo()}>
              <Undo2 size={16} /> Undo
            </button>
            <button type="button" className="mv-quiet" disabled={Boolean(working) || redoSteps.length === 0} onClick={() => void redo()}>
              <Redo2 size={16} /> Redo
            </button>
            <button type="button" className="mv-primary" onClick={onExport}><Download size={16} /> Export</button>
          </>}
        </div>
      </header>

      <main className={['music-video-editor-main', toolsOpen ? '' : 'tools-hidden', selectedClip || draft ? 'inspecting' : ''].filter(Boolean).join(' ')}>
        <aside className="music-video-library" aria-label="Library" hidden={!toolsOpen}>
          <div className="music-video-library-tabs" role="tablist" aria-label="Library views">
            {LIBRARY_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                id={`mv-tab-${tab.value}`}
                aria-controls={`mv-panel-${tab.value}`}
                aria-selected={libraryTab === tab.value}
                onClick={() => setLibraryTab(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <section className="music-video-source-panel" role="tabpanel" id="mv-panel-media" aria-labelledby="mv-tab-media" hidden={libraryTab !== 'media'}>
            <div className="mv-panel-head">
              <label className="music-video-search">
                <Search size={15} />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search this book"
                  aria-label="Search source clips"
                />
              </label>
              <button type="button" className="mv-icon" aria-label="Refresh media" title="Refresh media" onClick={() => void onRefreshAssets().catch((caught: unknown) => setError(String(caught)))}>
                <RefreshCw size={15} />
              </button>
            </div>
            <div className="mv-panel-meta">
              <span>{sourceSelection.length} of {sourceAssets.length} selected</span>
              {sourceSelection.length > 0 && <button type="button" className="mv-link" onClick={() => setSourceSelection([])}>Clear</button>}
            </div>
            <div className="music-video-source-list">
              {sourceAssets.map((asset) => {
                const order = sourceSelection.indexOf(asset.artifactId)
                const previewing = previewSourceId === asset.artifactId
                return (
                  <button
                    type="button"
                    className={[order >= 0 ? 'selected' : '', previewing ? 'previewing' : ''].filter(Boolean).join(' ')}
                    aria-pressed={order >= 0}
                    aria-label={asset.label}
                    key={asset.artifactId}
                    onClick={() => toggleSource(asset.artifactId)}
                  >
                    <span className="music-video-source-thumb">
                      <SourceThumb asset={asset} />
                      {order >= 0 && <i>{order + 1}</i>}
                      {asset.duration !== null && <small>{formatTime(Math.round(asset.duration * fps), fps)}</small>}
                    </span>
                    <span className="music-video-source-name">{asset.label}</span>
                  </button>
                )
              })}
              {sourceAssets.length === 0 && <p>No ready video sources match this search.</p>}
            </div>
            <footer className="mv-panel-foot">
              <button
                type="button"
                className="mv-primary music-video-add-selected"
                disabled={clipActionsDisabled || sourceSelection.length === 0}
                onClick={() => void appendSelection()}
              >
                <Plus size={15} /> Add {sourceSelection.length || ''} to end
              </button>
              <button type="button" disabled={sourceSelection.length === 0} onClick={() => setLibraryTab('autocut')}>
                <Wand2 size={15} /> Auto-cut…
              </button>
            </footer>
          </section>

          <section className="mv-music-panel" role="tabpanel" id="mv-panel-music" aria-labelledby="mv-tab-music" hidden={libraryTab !== 'music'}>
            <div className="music-video-setup-card" data-status={setup.status}>
              <span className="mv-kicker"><AudioWaveform size={13} /> Soundtrack{audioAsset ? ` · ${audioAsset.label}` : ''}</span>
              {setup.status === 'loading' && <p>Building the exact canonical setup plan…</p>}
              {setup.status === 'needs-audio-track' && <>
                <p>{setup.message}</p>
                <button type="button" className="mv-primary" disabled={Boolean(working)} onClick={() => void createTrack('audio')}>
                  <Plus size={15} /> Create soundtrack track
                </button>
              </>}
              {(setup.status === 'ready' || setup.status === 'applying') && <>
                <strong>{setup.summary}</strong>
                <p>{setup.operationCount} atomic operations · ends at {formatTime(setup.timelineLimitFrame, fps)}</p>
                {setup.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                <button type="button" className="mv-primary" disabled={Boolean(working)} onClick={() => void applySetup()}>
                  <AudioWaveform size={15} /> Apply soundtrack
                </button>
              </>}
              {setup.status === 'applied' && <strong className="music-video-applied"><Check size={15} /> Soundtrack applied</strong>}
              {setup.status === 'error' && <>
                <p className="music-video-error">{setup.message}</p>
                <button type="button" disabled={Boolean(working)} onClick={() => void onReviewSetup()}>
                  <RefreshCw size={15} /> Review again
                </button>
              </>}
            </div>
            <div className="mv-control">
              <span>Snap edits to</span>
              <SegmentedControl label="Snap to music" options={snapOptions} value={snap} onChange={chooseSnap} />
              <p className="mv-hint">Hold Alt while dragging to ignore snapping.</p>
            </div>
            <MusicRhythmControls rhythm={rhythm} sequence={sequence} assets={assets} frame={playheadFrame}
              correctionsOpen={correctionsOpen} onCorrectionsOpenChange={setCorrectionsOpen} />
          </section>

          <section className="mv-autocut-panel" role="tabpanel" id="mv-panel-autocut" aria-labelledby="mv-tab-autocut" hidden={libraryTab !== 'autocut'}>
            <MusicDraftControls sources={selectedSources}
              trackId={mainTrack?.trackId ?? null} startFrame={rhythm.master?.timelineStartFrame ?? 0} endFrame={durationFrames} fps={fps}
              hasBars={hasBars} busy={Boolean(working)} draft={draft}
              onPlan={(options) => void makeDraft(options)} onOrder={setSourceSelection} />
          </section>
        </aside>

        <section className="music-video-preview-panel timeline-preview-body" aria-label="Program monitor">
          <div className="mv-monitor">
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
                  <span>Source · {previewAsset.label}</span>
                  <button type="button" onClick={() => setPreviewSourceId(null)}>Show sequence</button>
                </p>
              </div>
            ) : (
              <CanonicalSequencePlayer
                ref={playerRef}
                sequence={draft?.sequence ?? sequence}
                assets={playbackAssets}
                onFrameUpdate={updateFrame}
                initialFrame={playheadFrame}
                presentation="preview"
                allowFullscreen={false}
                editingEnabled={!draft}
                onKeyboardAction={playerKeyboard}
              />
            )}
          </div>
          <MusicVideoTransport
            frame={playheadFrame}
            durationFrames={Math.max(durationFrames, laneEnd)}
            fps={fps}
            previousBeat={beats.previous}
            nextBeat={beats.next}
            onTogglePlay={() => { setPreviewSourceId(null); playerRef.current?.togglePlay() }}
            onSeek={seekTo}
          />
        </section>

        <aside className="music-video-inspector" aria-label="Inspector" hidden={!toolsOpen}>
          {selectedClip && !draft && <button type="button" className="mv-link mv-back" onClick={() => setSelectedClipId(null)}>← Back to library</button>}
          {draft ? (
            <div className="mv-draft-summary">
              <span className="mv-kicker">Draft review</span>
              <strong>{draft.plan.summary}</strong>
              <p>{draft.shots.length} shots · replaces {draft.preview.diff.removedClipIds.length} clips</p>
              {draft.uncovered.length > 0 && <p className="music-video-error">Gaps remain, so the draft can't be applied. Allow repeated footage or add sources in Auto-cut.</p>}
              {draft.warnings.map((warning) => <small key={warning}>{warning}</small>)}
              <p className="mv-hint">The full shot list is in Auto-cut.</p>
            </div>
          ) : selectedClip && activeTrim ? (
            <MusicVideoClipInspector
              clip={selectedClip}
              label={selectedAsset?.label ?? 'Clip'}
              thumbnailUrl={selectedAsset?.thumbnailUrl ?? null}
              index={selectedIndex + 1}
              count={laneClips.length}
              fps={fps}
              trimStart={activeTrim.startFrame}
              trimEnd={activeTrim.endFrame}
              trimMin={trimMinimum}
              trimMax={Math.max(activeTrim.endFrame, trimMaximum)}
              speed={selectedSpeed}
              speedOptions={speedOptions}
              retimable={selectedClip.source.kind === 'timed'}
              busy={Boolean(working)}
              editsDisabled={clipActionsDisabled}
              canMoveEarlier={canMoveEarlier}
              canMoveLater={canMoveLater}
              canStretch={canStretch}
              onTrim={(edge, startFrame, endFrame) => {
                setTrimDraft({ clipId: selectedClip.clipId, startFrame, endFrame })
                void commitTrim(edge, startFrame, endFrame)
              }}
              onSpeed={(value) => void applySpeed(value)}
              onFit={(fit: ClipFit) => void runEdit('Fitting clip', { kind: 'transform', clip_id: selectedClip.clipId, fit })}
              onSplit={() => void splitSelected()}
              onStretch={() => void stretchSelected()}
              onMove={(offset) => void moveSelected(offset)}
              onDelete={() => void deleteSelected()}
            />
          ) : (
            <div className="mv-sequence-summary">
              <span className="mv-kicker">Sequence</span>
              <dl>
                <dt>Frame</dt><dd>{sequence.width} × {sequence.height}</dd>
                <dt>Rate</dt><dd>{parseFloat(fps.toFixed(2))} fps</dd>
                <dt>Length</dt><dd>{formatTime(durationFrames, fps)}</dd>
                <dt>Clips</dt><dd>{laneClips.length}</dd>
              </dl>
              {laneClips.length > 0
                ? <p>Select a clip on the timeline to trim, retime or delete it.</p>
                : <ol className="mv-steps">
                    <li>Pick footage in Media</li>
                    <li>Choose a soundtrack in Music</li>
                    <li>Auto-cut, or add clips and trim by hand</li>
                  </ol>}
            </div>
          )}
        </aside>

        <section className="music-video-timeline-panel" aria-label="Music video timeline">
          <button
            type="button"
            className="mv-resize-handle"
            aria-label="Resize timeline"
            title="Drag to resize the timeline (↑/↓)"
            onPointerDown={resizeTimeline}
            onKeyDown={resizeTimelineByKey}
          />
          <NotebookTimeline
            sequence={draft?.sequence ?? sequence} assets={assets} assembly={assembly}
            disabled={Boolean(working) || Boolean(draft)} frame={playheadFrame} address={address ?? ''}
            onSeek={seekTo} onSelectClip={selectClip} onExport={onExport} presentation="preview"
            onMoveClip={editorEnabled ? (clip, frame) => void runEdit('Moving clip', { kind: 'move', clip_id: clip.clipId, track_id: clip.trackId, timeline_start_frame: frame }) : undefined}
            onRemoveClip={(clip) => void runEdit('Removing clip', { kind: 'remove_clip', clip_id: clip.clipId, ripple: false })}
            onTrimClip={editorEnabled ? (clip, edge, startFrame, endFrame) => {
              if (clip.clipId !== selectedClip?.clipId) return
              setTrimDraft({ clipId: clip.clipId, startFrame, endFrame })
              void commitTrim(edge, startFrame, endFrame)
            } : undefined}
            trimBounds={selectedClip ? { min: trimMinimum, max: Math.max(clipEnd(selectedClip), trimMaximum) } : undefined}
            rhythm={{ masterClipId: rhythm.master?.clipId ?? null, markers: rhythm.mapped, analysis: rhythm.analysis, snap }}
            toolbar={<>
              <span>Snap</span>
              <SegmentedControl label="Snap to music" options={snapOptions} value={snap} onChange={chooseSnap} />
              {!rhythm.master && <button type="button" disabled={rhythm.busy} onClick={() => openRhythmSettings()}>Choose soundtrack</button>}
              {rhythm.master && !hasBeats && !analysisPending && <button type="button" disabled={rhythm.busy} onClick={() => void rhythm.analyze(Boolean(rhythm.analysis))}>
                {rhythm.analysis ? 'Analyze again' : 'Analyze beats'}
              </button>}
              {analysisPending && <button type="button" disabled={rhythm.busy} onClick={() => void rhythm.cancel()}>Cancel analysis</button>}
              {rhythm.master && !hasBeats && rhythm.analysis && !analysisPending && <button type="button" disabled={rhythm.busy} onClick={() => openRhythmSettings()}>Set beat grid</button>}
              {hasBeats && !hasBars && <button type="button" disabled={rhythm.busy || analysisPending} onClick={() => openRhythmSettings('bars')}>Set bars</button>}
              <button type="button" disabled={clipActionsDisabled || !selectedClip} title="Split the selected clip at the playhead (S)" onClick={() => void splitSelected()}>
                <Scissors size={14} /> Split
              </button>
              {rhythm.master && <span className="music-master-name" title={audioAsset?.label}>♪ {audioAsset?.label ?? 'Soundtrack'}</span>}
              <span role="status">{beatStatus}</span>
            </>}
          />
          {overflowFrames > 0 && <p>{overflowFrames} frames beyond soundtrack</p>}
        </section>
      </main>

      <footer className="music-video-status" aria-live="polite">
        <span>{working ?? (draft ? 'Draft ready · review it, then apply or discard' : 'Saved')}</span>
        {(error || rhythm.error) && <strong role="alert">{error || rhythm.error}</strong>}
        <span className="mv-shortcuts">Space play · J/L shuttle · ←/→ frame · I/O trim · S split · Delete · ⌘Z undo</span>
      </footer>
    </dialog>,
    document.body,
  )
}

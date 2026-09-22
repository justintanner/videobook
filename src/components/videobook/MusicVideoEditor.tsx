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
  useCallback,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { Sequence, SequenceClip, TimedSequenceClip } from 'videobook-engine'
import {
  composerDockHideSkipsBlurCommit,
  initialMusicDockView,
} from '@/videobook/composer-dock'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import { NotebookTimeline, type NotebookTimelineProps } from './NotebookTimeline'
import { MusicRhythmControls } from './MusicRhythmControls'
import { MusicDraftControls } from './MusicDraftControls'
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
  )].filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))
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
  const [localDock, setLocalDock] = useState<HTMLDivElement | null>(null)
  const dockPortal = localDock
  const [dockOpen, setDockOpen] = useState(setup.status !== 'timeline')
  const [timelineHeight, setTimelineHeight] = useState(30)
  const [snap, setSnap] = useState<'off' | 'beats' | 'bars'>('beats')
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
  const [speedDraft, setSpeedDraft] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undoSteps, setUndoSteps] = useState<RevisionStep[]>([])
  const [redoSteps, setRedoSteps] = useState<RevisionStep[]>([])
  const [previewSourceId, setPreviewSourceId] = useState<string | null>(null)
  const [dockView, setDockView] = useState<'sources' | 'soundtrack' | 'clip'>(
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
  const speedOptions: Array<{ label: string; value: string }> = SPEEDS.some(
    (speed) => speed.value === selectedSpeed,
  )
    ? [...SPEEDS]
    : [{ label: speedLabel(selectedSpeed), value: selectedSpeed }, ...SPEEDS]

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
      setSpeedDraft(null)
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
    setDockView(sequence.tracks.find((track) => track.trackId === clip.trackId)?.kind === 'audio' ? 'soundtrack' : 'clip')
    setDockOpen(true)
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
    if (action === 'search') searchRef.current?.focus()
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
        <div className="music-video-title">
          <span className="music-video-kicker"><AudioWaveform size={14} /> MUSIC VIDEO</span>
          <h1>{draft ? 'Draft preview' : address ? `Timeline ${address}` : audioAsset?.label ?? 'Timeline'}</h1>
          <p>{sequence.width} × {sequence.height} · {formatTime(durationFrames, fps)} · {fps.toFixed(2)} fps</p>
        </div>
        <div className="music-video-header-actions">
          {draft && <>
            <button type="button" disabled={Boolean(working) || draft.uncovered.length > 0} onClick={() => void applyDraft()}>Apply draft</button>
            <button type="button" disabled={Boolean(working)} onClick={() => { playerRef.current?.pause(); setDraft(null) }}>Cancel draft</button>
          </>}
          {dockPortal && setup.status === 'needs-audio-track' && (
            <button type="button" disabled={Boolean(working)} onClick={() => void createTrack('audio')}>
              <Plus size={15} /> Create soundtrack track
            </button>
          )}
          {dockPortal && (setup.status === 'ready' || setup.status === 'applying') && (
            <button type="button" disabled={Boolean(working)} onClick={() => void applySetup()}>
              <AudioWaveform size={15} /> Apply soundtrack
            </button>
          )}
          {dockPortal && setup.status === 'error' && (
            <button type="button" disabled={Boolean(working)} onClick={() => void onReviewSetup()}>
              <RefreshCw size={15} /> Review again
            </button>
          )}
          <button type="button" hidden={Boolean(draft)} disabled={Boolean(working) || undoSteps.length === 0} onClick={() => void undo()}>
            <Undo2 size={16} /> Undo
          </button>
          <button type="button" hidden={Boolean(draft)} disabled={Boolean(working) || redoSteps.length === 0} onClick={() => void redo()}>
            <Redo2 size={16} /> Redo
          </button>
          <button type="button" hidden={Boolean(draft)} onClick={onExport}>Export</button>
          <button className="music-video-close" type="button" onClick={onClose} aria-label={address ? "Close timeline preview" : "Close music video editor"}>
            <X size={20} />
          </button>
        </div>
      </header>

      <main className="music-video-editor-main docked">
        <div ref={setLocalDock} className="music-video-local-dock" hidden={!dockOpen} />
        {dockPortal ? createPortal((
          <div className="music-video-dock">
            <nav className="music-video-dock-tabs" aria-label="Music editor views">
              <button type="button" aria-pressed={dockView === 'sources'} onClick={() => { setDockView('sources'); setDockOpen(true) }}>Sources</button>
              <button type="button" aria-pressed={dockView === 'soundtrack'} onClick={() => { setDockView('soundtrack'); setDockOpen(true) }}>Soundtrack</button>
              <button type="button" aria-pressed={dockView === 'clip'} onClick={() => { setDockView('clip'); setDockOpen(true) }}>Clip</button>
              <button type="button" data-composer-dock-hide onClick={() => setDockOpen(false)}>Hide tools</button>
            </nav>
            <div hidden={dockView !== 'sources'}>
        <section className="music-video-source-panel" aria-label="Current book video sources">
          <header>
            <div className="music-video-panel-title">
              <span>SOURCE CLIPS</span>
              <strong>{sourceSelection.length} of {sourceAssets.length} selected</strong>
              <button type="button" onClick={() => void onRefreshAssets().catch((caught: unknown) => setError(String(caught)))}>Refresh media</button>
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
            disabled={clipActionsDisabled || sourceSelection.length === 0}
            onClick={() => void appendSelection()}
          >
            <Plus size={15} /> Add selected
          </button>
        </section>
        <MusicDraftControls sources={sourceSelection.flatMap((id) => { const asset = assetById.get(id); return asset ? [asset] : [] })}
          trackId={mainTrack?.trackId ?? null} startFrame={rhythm.master?.timelineStartFrame ?? 0} endFrame={durationFrames} fps={fps}
          hasBars={rhythm.mapped.some((marker) => marker.bar)} busy={Boolean(working)} draft={draft}
          onPlan={(options) => void makeDraft(options)} onOrder={setSourceSelection} />
            </div>
          </div>
        ), dockPortal) : null}

        <section className="music-video-preview-panel timeline-preview-body" aria-label="Program monitor">
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
        </section>

        {dockPortal ? createPortal((
        <section className="music-video-inspector" aria-label="Selected clip controls" hidden={dockView !== 'soundtrack' && dockView !== 'clip'}>
          <aside className="music-video-setup-card" data-status={setup.status} hidden={dockView !== 'soundtrack'}>
            <span><AudioWaveform size={13} /> MASTER SOUNDTRACK</span>
            <MusicRhythmControls rhythm={rhythm} sequence={sequence} assets={assets} frame={playheadFrame} />
            {setup.status === 'loading' && <p>Building the exact canonical setup plan…</p>}
            {setup.status === 'needs-audio-track' && (
              <>
                <p>{setup.message}</p>
                {!dockPortal && (
                  <button type="button" disabled={Boolean(working)} onClick={() => void createTrack('audio')}>
                    <Plus size={15} /> Create soundtrack track
                  </button>
                )}
              </>
            )}
            {(setup.status === 'ready' || setup.status === 'applying') && (
              <>
                <strong>{setup.summary}</strong>
                <p>{setup.operationCount} atomic operations · ends at frame {setup.timelineLimitFrame}</p>
                {setup.warnings.map((warning) => <small key={warning}>{warning}</small>)}
                {!dockPortal && (
                  <button type="button" disabled={Boolean(working)} onClick={() => void applySetup()}>
                    <AudioWaveform size={15} /> Apply soundtrack
                  </button>
                )}
              </>
            )}
            {setup.status === 'applied' && (
              <strong className="music-video-applied"><Check size={15} /> Soundtrack applied</strong>
            )}
            {setup.status === 'error' && (
              <>
                <p className="music-video-error">{setup.message}</p>
                {!dockPortal && (
                  <button type="button" disabled={Boolean(working)} onClick={() => void onReviewSetup()}>
                    <RefreshCw size={15} /> Review again
                  </button>
                )}
              </>
            )}
          </aside>

          <div className="music-video-clip-panel" hidden={dockView !== 'clip'}>
            {!selectedClip && (
              <div className="music-video-inspector-empty">
                <span className="music-video-kicker">SELECTED CLIP</span>
                <p>Select a main-lane clip to trim, cut, delete, move, or stretch it.</p>
                {laneClips.length === 0 && (
                  <p>Open Sources and add selected footage at its original speed.</p>
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
                      onBlur={(event) => {
                        if (composerDockHideSkipsBlurCommit(event.relatedTarget)) return
                        void commitTrim(
                          'start',
                          Number(event.currentTarget.value),
                          activeTrim.endFrame,
                        )
                      }}
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
                      onBlur={(event) => {
                        if (composerDockHideSkipsBlurCommit(event.relatedTarget)) return
                        void commitTrim(
                          'end',
                          activeTrim.startFrame,
                          Number(event.currentTarget.value),
                        )
                      }}
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
                  <label>Frame fit<select aria-label="Clip frame fit" value={selectedClip.transform?.fit ?? 'fit'} disabled={clipActionsDisabled} onChange={(event) => void runEdit('Fitting clip', { kind: 'transform', clip_id: selectedClip.clipId, fit: event.target.value })}>
                    <option value="fit">Fit full frame</option><option value="fill">Fill frame</option><option value="crop">Crop</option>
                  </select></label>
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
        ), dockPortal) : null}

        <section className="music-video-timeline-panel" aria-label="Music video timeline">
          <NotebookTimeline
            sequence={draft?.sequence ?? sequence} assets={assets} assembly={assembly}
            disabled={Boolean(working) || Boolean(draft)} frame={playheadFrame} address={address ?? ''}
            onSeek={seekTo} onSelectClip={selectClip} onExport={onExport} presentation="preview"
            onMoveClip={editorEnabled ? (clip, frame) => void runEdit('Moving clip', { kind: 'move', clip_id: clip.clipId, track_id: clip.trackId, timeline_start_frame: frame }) : undefined}
            onRemoveClip={(clip) => void runEdit('Removing clip', { kind: 'remove_clip', clip_id: clip.clipId, ripple: false })}
            rhythm={{ masterClipId: rhythm.master?.clipId ?? null, markers: rhythm.mapped, analysis: rhythm.analysis, snap }}
            toolbar={<>
              <button type="button" aria-pressed={dockOpen && dockView === 'sources'} onClick={() => { setDockView('sources'); setDockOpen(true) }}>Sources</button>
              <button type="button" aria-pressed={dockOpen && dockView === 'soundtrack'} onClick={() => { setDockView('soundtrack'); setDockOpen(true) }}>Soundtrack</button>
              <button type="button" disabled={!selectedClip} onClick={() => { setDockView('clip'); setDockOpen(true) }}>Clip tools</button>
              <button type="button" disabled={!rhythm.master || rhythm.busy || rhythm.status === 'analyzing' || rhythm.status === 'queued'} onClick={() => void rhythm.analyze()}>Analyze beats</button>
              {rhythm.master && <span className="music-master-name" title={audioAsset?.label}>♪ {audioAsset?.label ?? 'Soundtrack'}</span>}
              <label title="Hold Alt while dragging to ignore snapping">Snap<select aria-label="Snap to music" value={snap} onChange={(event) => setSnap(event.target.value as typeof snap)}>
                <option value="off">Off</option><option value="beats">Beats</option><option value="bars" disabled={!rhythm.mapped.some((marker) => marker.bar)}>Bars</option>
              </select></label>
              <button type="button" disabled={!rhythm.mapped.some((marker) => marker.frame < playheadFrame)} onClick={() => { const marker = [...rhythm.mapped].reverse().find((item) => item.frame < playheadFrame); if (marker) seekTo(marker.frame) }}>Previous beat</button>
              <button type="button" disabled={!rhythm.mapped.some((marker) => marker.frame > playheadFrame)} onClick={() => { const marker = rhythm.mapped.find((item) => item.frame > playheadFrame); if (marker) seekTo(marker.frame) }}>Next beat</button>
              <button type="button" disabled={clipActionsDisabled || !selectedClip} onClick={() => void splitSelected()}>Split</button>
              <label className="music-timeline-resize">Timeline height<input aria-label="Timeline height" type="range" min="20" max="55" value={timelineHeight} onChange={(event) => setTimelineHeight(Number(event.target.value))} /></label>
              <span role="status">{rhythm.status === 'queued' || rhythm.status === 'analyzing' ? 'Analyzing beats…' : rhythm.mapped.length ? `${rhythm.mapped.length} beats` : ''}</span>
            </>}
          />
          {overflowFrames > 0 && <p>{overflowFrames} frames beyond soundtrack</p>}
        </section>
      </main>

      <footer className="music-video-status" aria-live="polite">
        <span>{working ?? 'Space/K play · J/L shuttle · arrows frame · I/O trim marks · S cut · Delete · ⌘Z undo'}</span>
        {(error || rhythm.error) && <strong role="alert">{error || rhythm.error}</strong>}
      </footer>
    </dialog>,
    document.body,
  )
}

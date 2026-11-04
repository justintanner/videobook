import { useCallback, useState, type RefObject } from 'react'
import type { EditPreview, Sequence } from 'videobook-engine'
import type {
  MusicVideoCommitResult,
  MusicVideoSetupState,
} from '@/components/videobook/MusicVideoEditor'
import type { MusicDraftOptions, MusicVideoDraft } from '../../server/src/rhythm/draft-model'
import type { ChatExecution } from './chat-turns'
import type { CommandPlan, EditCommandStage } from './command-plan'
import { editPreviewError } from './command-plan-edit'
import { capturePointerComposerFocus } from './command-composer-focus'
import { sequenceContentRevision } from './sequence-revision'
import type { useMusicRhythm } from './useMusicRhythm'
import { asString, recordValue } from './value-decoders'
import { asCommandPlan, asSequence } from './workspace-responses'

type MusicVideoEditingOptions = {
  bookId: string
  call: (
    tool: string,
    args: Record<string, unknown>,
    options?: { background?: boolean; chat?: ChatExecution },
  ) => Promise<unknown>
  musicRhythm: ReturnType<typeof useMusicRhythm>
  setSequence: (sequence: Sequence) => void
  setLastEditActionId: (actionId: string) => void
  watchSnapshotClockRef: RefObject<number>
}

type MusicVideoPreparedSetup = Extract<
  MusicVideoSetupState,
  { status: 'ready' }
> & {
  plan: CommandPlan
  preview: EditPreview
}

type MusicVideoSession = {
  key: string
  audioArtifactId: string
  returnFocus: HTMLElement | null
  setup:
    | Exclude<MusicVideoSetupState, { status: 'ready' }>
    | MusicVideoPreparedSetup
}

function musicVideoSoundtrackTrack(
  sequence: Sequence,
  audioArtifactId: string,
) {
  const candidates = sequence.tracks.filter((track) =>
    track.kind === 'audio' && track.enabled && !track.locked && !track.muted)
  const existing = candidates.find((track) => {
    const clips = sequence.clips.filter((clip) => clip.trackId === track.trackId)
    return clips.length === 1
      && clips[0]?.timelineStartFrame === 0
      && clips[0].source.kind === 'timed'
      && clips[0].source.artifactId === audioArtifactId
  })
  return existing ?? candidates.find((track) =>
    !sequence.clips.some((clip) => clip.trackId === track.trackId)) ?? null
}

function musicVideoSoundtrackApplied(
  sequence: Sequence,
  audioArtifactId: string,
  timelineLimitFrame: number,
): boolean {
  const track = musicVideoSoundtrackTrack(sequence, audioArtifactId)
  if (!track) return false
  const clips = sequence.clips.filter((clip) => clip.trackId === track.trackId)
  const clip = clips[0]
  return clips.length === 1
    && clip !== undefined
    && clip.timelineStartFrame === 0
    && clip.durationFrames === timelineLimitFrame
    && clip.source.kind === 'timed'
    && clip.source.artifactId === audioArtifactId
}

function musicVideoTimelineLimit(
  plan: CommandPlan,
  sequence: Sequence,
  audioArtifactId: string,
): number {
  const stage = plan.stages.find(
    (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
  )
  const inserted = stage?.intent.operations.find((operation) =>
    operation.kind === 'insert-clip'
    && operation.placement.source.artifactId === audioArtifactId)
  if (inserted?.kind === 'insert-clip') return inserted.placement.durationFrames
  const existing = sequence.clips.find((clip) =>
    clip.timelineStartFrame === 0
    && clip.source.kind === 'timed'
    && clip.source.artifactId === audioArtifactId)
  const trimmed = stage?.intent.operations.find((operation) =>
    operation.kind === 'trim-clip' && operation.clipId === existing?.clipId)
  if (trimmed?.kind === 'trim-clip') return trimmed.durationFrames
  if (existing) return existing.durationFrames
  throw new Error('The soundtrack setup plan has no duration boundary')
}

function musicVideoSetupSummary(plan: CommandPlan): string {
  const operations = plan.stages.flatMap((stage) =>
    stage.kind === 'edit' ? stage.intent.operations : [])
  const inserts = operations.filter((operation) => operation.kind === 'insert-clip').length
  const muted = operations.filter((operation) =>
    operation.kind === 'set-clip-audio'
      ? operation.audio.muted
      : operation.kind === 'set-clip-speed' && operation.audioPolicy === 'mute')
    .length
  return `${inserts > 0 ? 'Place' : 'Normalize'} master soundtrack · mute ${muted} other ${muted === 1 ? 'clip' : 'clips'}`
}

export function useMusicVideoEditing({
  bookId,
  call,
  musicRhythm,
  setSequence,
  setLastEditActionId,
  watchSnapshotClockRef,
}: MusicVideoEditingOptions) {
  const [musicVideoSession, setMusicVideoSession] = useState<MusicVideoSession | null>(null)

  const prepareMusicVideoSetup = async (
    sessionKey: string,
    audioArtifactId: string,
    targetSequence: Sequence,
    chat?: ChatExecution,
  ): Promise<void> => {
    if (!bookId) {
      setMusicVideoSession((current) => current?.key === sessionKey
        ? {
            ...current,
            setup: {
              status: 'error',
              message: 'Load or create a book first.',
            },
          }
        : current)
      return
    }
    setMusicVideoSession((current) => current?.key === sessionKey
      ? { ...current, setup: { status: 'loading' } }
      : current)
    const audioTrack = musicVideoSoundtrackTrack(targetSequence, audioArtifactId)
    if (!audioTrack) {
      setMusicVideoSession((current) => current?.key === sessionKey
        ? {
            ...current,
            setup: {
              status: 'needs-audio-track',
              message: 'Create an empty, enabled soundtrack track before reviewing setup.',
            },
          }
        : current)
      return
    }
    try {
      const plan = asCommandPlan(await call('plan_sequence_edit', {
        book_id: bookId,
        source_surface: 'ui',
        actor: 'videobook-user',
        expected_revision: await sequenceContentRevision(targetSequence),
        edits: [{
          kind: 'music_video_setup',
          audio_artifact_id: audioArtifactId,
          audio_track_id: audioTrack.trackId,
        }],
      }, { chat }))
      const stage = plan.stages.find(
        (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
      )
      if (!stage) throw new Error('The soundtrack setup plan has no edit stage')
      const preview = await call('preview_edit_intent', {
        book_id: bookId,
        intent: stage.intent,
      }, { chat }) as EditPreview
      const invalid = editPreviewError(preview)
      if (invalid) throw new Error(invalid)
      const timelineLimitFrame = musicVideoTimelineLimit(
        plan,
        targetSequence,
        audioArtifactId,
      )
      if (musicVideoSoundtrackApplied(
        targetSequence,
        audioArtifactId,
        timelineLimitFrame,
      )) {
        setMusicVideoSession((current) => current?.key === sessionKey
          ? {
              ...current,
              setup: {
                status: 'applied',
                audioTrackId: audioTrack.trackId,
                timelineLimitFrame,
              },
            }
          : current)
        return
      }
      const prepared: MusicVideoPreparedSetup = {
        status: 'ready',
        audioTrackId: audioTrack.trackId,
        timelineLimitFrame,
        operationCount: stage.intent.operations.length,
        summary: musicVideoSetupSummary(plan),
        warnings: preview.warnings.map((warning) => warning.message),
        plan,
        preview,
      }
      setMusicVideoSession((current) => current?.key === sessionKey
        ? { ...current, setup: prepared }
        : current)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMusicVideoSession((current) => current?.key === sessionKey
        ? { ...current, setup: { status: 'error', message } }
        : current)
    }
  }

  const applyMusicVideoSetup = async (): Promise<MusicVideoCommitResult> => {
    if (!bookId || !musicVideoSession || musicVideoSession.setup.status !== 'ready') {
      throw new Error('Review the soundtrack setup before applying it')
    }
    const sessionKey = musicVideoSession.key
    const prepared = musicVideoSession.setup
    const stage = prepared.plan.stages.find(
      (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
    )
    if (!stage) throw new Error('The soundtrack setup plan has no edit stage')
    setMusicVideoSession((current) => current?.key === sessionKey
      ? {
          ...current,
          setup: {
            status: 'applying',
            audioTrackId: prepared.audioTrackId,
            timelineLimitFrame: prepared.timelineLimitFrame,
            operationCount: prepared.operationCount,
            summary: prepared.summary,
            warnings: prepared.warnings,
          },
        }
      : current)
    try {
      const committed = recordValue(await call('commit_edit_intent', {
        book_id: bookId,
        intent: stage.intent,
        preview_hash: prepared.preview.previewHash,
      }))
      const nextSequence = asSequence(committed?.sequence)
      const actionId = asString(committed?.actionId)
      if (!nextSequence || !actionId) {
        throw new Error('The server returned an invalid soundtrack commit')
      }
      setSequence(nextSequence)
      setLastEditActionId(actionId)
      const master = nextSequence.clips.find((clip) => clip.trackId === prepared.audioTrackId && clip.source.artifactId === musicVideoSession.audioArtifactId)
      if (master) await musicRhythm.save({ masterClipId: master.clipId, correction: null }, nextSequence)
      setMusicVideoSession((current) => current?.key === sessionKey
        ? {
            ...current,
            setup: {
              status: 'applied',
              audioTrackId: prepared.audioTrackId,
              timelineLimitFrame: prepared.timelineLimitFrame,
            },
          }
        : current)
      return {
        sequence: nextSequence,
        actionId,
        beforeRevision: stage.intent.baseRevision,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMusicVideoSession((current) => current?.key === sessionKey
        ? { ...current, setup: { status: 'error', message } }
        : current)
      throw error
    }
  }

  const commitMusicVideoEdit = async (
    request: Record<string, unknown>,
    expectedSequence: Sequence,
  ): Promise<MusicVideoCommitResult> => {
    if (!bookId) throw new Error('Load or create a book first.')
    const plan = asCommandPlan(await call('plan_sequence_edit', {
      book_id: bookId,
      source_surface: 'ui',
      actor: 'videobook-user',
      expected_revision: await sequenceContentRevision(expectedSequence),
      edits: [request],
    }))
    const stage = plan.stages.find(
      (candidate): candidate is EditCommandStage => candidate.kind === 'edit',
    )
    if (!stage) throw new Error('The music-video plan has no edit stage')
    const preview = await call('preview_edit_intent', {
      book_id: bookId,
      intent: stage.intent,
    }) as EditPreview
    const invalid = editPreviewError(preview)
    if (invalid) throw new Error(invalid)
    const committed = recordValue(await call('commit_edit_intent', {
      book_id: bookId,
      intent: stage.intent,
      preview_hash: preview.previewHash,
    }))
    const nextSequence = asSequence(committed?.sequence)
    const actionId = asString(committed?.actionId)
    if (!nextSequence || !actionId) {
      throw new Error('The server returned an invalid music-video edit commit')
    }
    watchSnapshotClockRef.current = performance.now()
    setSequence(nextSequence)
    setLastEditActionId(actionId)
    return {
      sequence: nextSequence,
      actionId,
      beforeRevision: stage.intent.baseRevision,
    }
  }

  const planMusicDraft = async (options: MusicDraftOptions, expectedSequence: Sequence): Promise<MusicVideoDraft> => {
    return await call('plan_music_video', {
      book_id: bookId, expected_revision: await sequenceContentRevision(expectedSequence),
      rhythm_revision: musicRhythm.rhythm.revision, options, source_surface: 'ui', actor: 'videobook-user',
    }) as MusicVideoDraft
  }

  const applyMusicDraft = async (draft: MusicVideoDraft): Promise<MusicVideoCommitResult> => {
    const intent = draft.plan.stages[0]?.intent
    if (!intent || draft.uncovered.length) throw new Error('Review a complete draft before applying it')
    const result = recordValue(await call('commit_music_video', { book_id: bookId, intent, preview_hash: draft.preview.previewHash, rhythm_revision: draft.rhythmRevision, sequence_content_revision: draft.sequenceContentRevision }))
    const next = asSequence(result?.sequence)
    const actionId = asString(result?.actionId)
    if (!next || !actionId) throw new Error('The server returned an invalid draft commit')
    watchSnapshotClockRef.current = performance.now()
    setSequence(next)
    setLastEditActionId(actionId)
    return { sequence: next, actionId, beforeRevision: intent.baseRevision }
  }

  const restoreMusicVideoRevision = async (
    targetRevision: string,
    expectedRevision: string,
  ): Promise<MusicVideoCommitResult> => {
    if (!bookId) throw new Error('Load or create a book first.')
    const restored = recordValue(await call('restore_edit_action', {
      book_id: bookId,
      target_revision: targetRevision,
      base_revision: expectedRevision,
      actor: 'videobook-user',
      source_surface: 'ui',
    }))
    const nextSequence = asSequence(restored?.sequence)
    const actionId = asString(restored?.actionId)
    if (!nextSequence || !actionId) {
      throw new Error('The server returned an invalid sequence restore')
    }
    watchSnapshotClockRef.current = performance.now()
    setSequence(nextSequence)
    setLastEditActionId(actionId)
    return {
      sequence: nextSequence,
      actionId,
      beforeRevision: expectedRevision,
    }
  }

  const createMusicVideoTrack = async (
    kind: 'video' | 'audio',
  ): Promise<Sequence> => {
    if (!bookId) throw new Error('Load or create a book first.')
    const nextSequence = asSequence(await call('add_sequence_track', {
      book_id: bookId,
      kind,
      name: kind === 'audio' ? 'Master Soundtrack' : 'Music Video',
    }))
    if (!nextSequence) throw new Error('The server returned an invalid sequence')
    watchSnapshotClockRef.current = performance.now()
    setSequence(nextSequence)
    return nextSequence
  }

  const closeMusicVideoEditor = useCallback(() => {
    const restoreFocus = capturePointerComposerFocus()
    setMusicVideoSession(null)
    restoreFocus()
  }, [])

  return {
    musicVideoSession,
    setMusicVideoSession,
    prepareMusicVideoSetup,
    applyMusicVideoSetup,
    commitMusicVideoEdit,
    planMusicDraft,
    applyMusicDraft,
    restoreMusicVideoRevision,
    createMusicVideoTrack,
    closeMusicVideoEditor,
  }
}

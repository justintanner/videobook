import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditPreview, Sequence } from 'videobook-engine'
import { validateCommandPlan, type CommandPlan } from './command-plan'
import { sequenceContentRevision } from './sequence-revision'
import { recordValue } from './value-decoders'

export interface TimelineAsset {
  artifactId: string
  label: string
  type: string
  status: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  duration?: number | null
  waveform?: number[] | null
}

interface TimelineOptions<Asset extends TimelineAsset> {
  bookId: string
  ready: boolean
  sequence: Sequence | null
  call: (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>
  parseSequence: (value: unknown) => Sequence | null
  parseAssets: (value: unknown) => Asset[]
  onSequence: (sequence: Sequence) => void
  onAssets: (assets: Asset[]) => void
}

interface TimelinePlayback {
  sequenceId: string | undefined
  frame: number
  selectedClipId: string | null
}

export function useTimelineAssembly<Asset extends TimelineAsset>(options: TimelineOptions<Asset>) {
  const { bookId, call, sequence } = options
  const scope = useMemo(() => ({ bookId }), [bookId])
  const scopeRef = useRef({ key: scope, active: true, pending: false })
  const [work, setWork] = useState({ scope, busy: false, error: '' })
  const sequenceId = sequence?.sequenceId
  const [playback, setPlayback] = useState<TimelinePlayback>({ sequenceId, frame: 0, selectedClipId: null })
  const seek = useCallback((frame: number) => {
    setPlayback((current) => ({
      sequenceId,
      frame,
      selectedClipId: current.sequenceId === sequenceId ? current.selectedClipId : null,
    }))
  }, [sequenceId])
  const [picker, setPicker] = useState<{
    scope: typeof scope
    trackId: string
    items: Asset[]
    offset: number | null
  } | null>(null)
  const pickerEpoch = useRef(0)
  useEffect(() => {
    const current = { key: scope, active: true, pending: false }
    scopeRef.current = current
    return () => { current.active = false }
  }, [scope])

  async function run(action: (isCurrent: () => boolean) => Promise<void>) {
    const current = scopeRef.current
    if (!options.ready || current.key !== scope || !current.active || current.pending) return
    const isCurrent = () => current.active && scopeRef.current === current
    current.pending = true
    setWork({ scope, busy: true, error: '' })
    try {
      await action(isCurrent)
      if (isCurrent()) setWork({ scope, busy: false, error: '' })
    } catch (error) {
      if (isCurrent()) setWork({ scope, busy: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      current.pending = false
    }
  }

  async function loadPage(trackId: string, offset: number, append: boolean) {
    const epoch = ++pickerEpoch.current
    await run(async (isCurrent) => {
      const track = sequence?.tracks.find((entry) => entry.trackId === trackId)
      if (!track) throw new Error('The track is no longer available')
      const result = await call('list_assets', {
        book_id: bookId, browse_status: 'ready', sort: 'newest', offset, limit: 100,
      }, { background: true })
      if (!isCurrent() || epoch !== pickerEpoch.current) return
      const assets = options.parseAssets(result)
      options.onAssets(assets)
      const items = assets.filter((asset) => asset.mediaUrl && asset.status === 'ready'
        && (track.kind === 'audio' ? asset.type === 'audio' : asset.type === 'video' || asset.type === 'final'))
      const page = recordValue(recordValue(result)?.page)
      setPicker((current) => ({
        scope, trackId,
        items: append && current?.scope === scope && current.trackId === trackId ? [...current.items, ...items] : items,
        offset: page?.hasMore === true ? offset + 100 : null,
      }))
    })
  }

  async function edit(request: Record<string, unknown>) {
    await run(async (isCurrent) => {
      if (!sequence) throw new Error('The timeline is not ready')
      const plan = await call('plan_sequence_edit', {
        book_id: bookId, source_surface: 'ui', actor: 'videobook-user',
        expected_revision: await sequenceContentRevision(sequence), request,
      }) as CommandPlan
      validateCommandPlan(plan)
      if (!isCurrent()) return
      const stage = plan.stages.find((entry) => entry.kind === 'edit')
      if (!stage || stage.kind !== 'edit') throw new Error('The timeline plan has no edit')
      const preview = await call('preview_edit_intent', { book_id: bookId, intent: stage.intent }) as EditPreview
      if (!preview.valid) throw new Error(preview.conflicts.map((entry) => entry.message).join(' · ') || 'The timeline changed. Try again.')
      if (!isCurrent()) return
      const committed = recordValue(await call('commit_edit_intent', {
        book_id: bookId, intent: stage.intent, preview_hash: preview.previewHash,
      }))
      const next = options.parseSequence(committed?.sequence)
      if (!next) throw new Error('The server returned an invalid timeline')
      if (isCurrent()) {
        options.onSequence(next)
        setPicker(null)
      }
    })
  }

  async function trackChange(tool: string, args: Record<string, unknown>) {
    await run(async (isCurrent) => {
      const next = options.parseSequence(await call(tool, { book_id: bookId, ...args }))
      if (!next) throw new Error('The server returned an invalid timeline')
      if (isCurrent()) options.onSequence(next)
    })
  }

  return {
    frame: playback.sequenceId === sequenceId ? playback.frame : 0,
    selectedClipId: playback.sequenceId === sequenceId ? playback.selectedClipId : null,
    seek,
    selectClip: (selectedClipId: string | null) => setPlayback((current) => ({
      sequenceId,
      frame: current.sequenceId === sequenceId ? current.frame : 0,
      selectedClipId,
    })),
    busy: work.scope === scope && work.busy,
    error: work.scope === scope ? work.error : '',
    picker: picker?.scope === scope ? picker : null,
    openPicker: (trackId: string) => loadPage(trackId, 0, false),
    loadMore: () => picker?.offset !== null && picker
      ? loadPage(picker.trackId, picker.offset, true) : Promise.resolve(),
    closePicker: () => { pickerEpoch.current += 1; setPicker(null) },
    append: (trackId: string, artifactId: string) => edit({ kind: 'append', track_id: trackId, artifact_id: artifactId }),
    removeClip: (clipId: string) => edit({ kind: 'remove_clip', clip_id: clipId, ripple: true }),
    addTrack: () => trackChange('add_sequence_track', { kind: 'audio' }),
    removeTrack: (trackId: string) => trackChange('remove_sequence_track', { track_id: trackId }),
  }
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Sequence } from 'videobook-engine'
import { musicAnalysisSchema, rhythmSettingsSchema, type MusicAnalysisState, type RhythmSettings, type RhythmState } from '../../server/src/rhythm/model'
import { effectiveMarkers, soundtrackClip, timelineMarkers } from '../../server/src/rhythm/timing'
import { recordValue } from './value-decoders'

type Call = (tool: string, args: Record<string, unknown>, options?: { background?: boolean }) => Promise<unknown>
interface Options {
  bookId: string
  ready: boolean
  sequence: Sequence | null
  call: Call
  onSequence: (value: unknown) => void
}

const emptyRhythm: RhythmState = { revision: 'none', settings: { masterClipId: null, correction: null }, canUndo: false, canRedo: false }

function readState(value: unknown): RhythmState {
  const row = recordValue(value)
  if (!row || typeof row.revision !== 'string') throw new Error('Invalid beat map response')
  return { revision: row.revision, settings: rhythmSettingsSchema.parse(row.settings), canUndo: row.canUndo === true, canRedo: row.canRedo === true }
}

function readAnalysis(value: unknown): MusicAnalysisState {
  const row = recordValue(value)
  if (!row || typeof row.status !== 'string' || !['missing', 'queued', 'analyzing', 'ready', 'no-beats', 'cancelled', 'failed'].includes(row.status)) throw new Error('Invalid music analysis response')
  return {
    status: row.status as MusicAnalysisState['status'], analysisId: String(row.analysisId),
    jobId: typeof row.jobId === 'number' ? row.jobId : null, error: typeof row.error === 'string' ? row.error : null,
    analysis: row.analysis ? musicAnalysisSchema.parse(row.analysis) : null,
  }
}

export function useMusicRhythm({ bookId, ready, sequence, call, onSequence }: Options) {
  const scope = `${bookId}:${sequence?.sequenceId ?? ''}`
  const epoch = useRef(0)
  const [data, setData] = useState<{ scope: string; rhythm: RhythmState; analysis: MusicAnalysisState | null }>({ scope, rhythm: emptyRhythm, analysis: null })
  const [activity, setActivity] = useState({ scope, busy: false, error: '' })
  useEffect(() => () => { epoch.current += 1 }, [scope])
  const rhythm = data.scope === scope ? data.rhythm : emptyRhythm
  const master = sequence ? soundtrackClip(sequence, rhythm.settings) : null
  const analysis = data.scope === scope && data.analysis?.analysis?.artifactId === master?.source.artifactId
    ? data.analysis?.analysis ?? null : null
  const markers = useMemo(() => effectiveMarkers(master, rhythm.settings, analysis), [master, rhythm.settings, analysis])
  const mapped = useMemo(() => sequence ? timelineMarkers(master, markers, sequence) : [], [master, markers, sequence])
  const status = data.scope === scope ? data.analysis?.status ?? 'missing' : 'missing'

  async function readFor(settings: RhythmSettings, targetSequence = sequence): Promise<MusicAnalysisState | null> {
    if (!targetSequence) return null
    const clip = soundtrackClip(targetSequence, settings)
    if (!clip) return null
    return readAnalysis(await call('get_music_analysis', { book_id: bookId, asset_id: clip.source.artifactId, stream_id: clip.source.range.streamId }, { background: true }))
  }

  function acceptRhythm(next: RhythmState, targetSequence: Sequence) {
    const source = soundtrackClip(targetSequence, next.settings)?.source
    setData(current => {
      const cached = current.scope === scope ? current.analysis : null
      const matches = cached?.analysis && source
        && cached.analysis.artifactId === source.artifactId
        && cached.analysis.objectHash === source.range.objectHash
        && cached.analysis.streamId === source.range.streamId
      return { scope, rhythm: next, analysis: matches ? cached : null }
    })
  }

  async function observe(ticket: number, next: RhythmState, result: MusicAnalysisState | null) {
    while (ticket === epoch.current) {
      setData({ scope, rhythm: next, analysis: result })
      setActivity({ scope, busy: false, error: '' })
      if (result?.status !== 'queued' && result?.status !== 'analyzing') return
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (ticket !== epoch.current) return
      result = await readFor(next.settings)
    }
  }

  async function load() {
    if (!ready || !sequence) return
    const ticket = ++epoch.current
    setActivity({ scope, busy: true, error: '' })
    try {
      const next = readState(await call('get_sequence_rhythm', { book_id: bookId, sequence_id: sequence.sequenceId }, { background: true }))
      if (ticket !== epoch.current) return
      acceptRhythm(next, sequence)
      const result = await readFor(next.settings)
      await observe(ticket, next, result)
    } catch (error) {
      if (ticket === epoch.current) setActivity({ scope, busy: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (ticket === epoch.current) setActivity({ scope, busy: false, error: '' })
  }

  async function save(update: RhythmSettings | 'undo' | 'redo', targetSequence = sequence) {
    if (!ready || !targetSequence) return
    const ticket = ++epoch.current
    setActivity({ scope, busy: true, error: '' })
    try {
      const result = recordValue(await call('update_sequence_rhythm', {
        book_id: bookId, sequence_id: targetSequence.sequenceId, expected_revision: rhythm.revision,
        operation: typeof update === 'string' ? update : 'set', ...(typeof update === 'string' ? {} : { settings: update }),
      }, { background: true }))
      if (ticket !== epoch.current) return
      const next = readState(result?.state)
      acceptRhythm(next, targetSequence)
      onSequence(result?.sequence)
      const current = await readFor(next.settings, targetSequence)
      await observe(ticket, next, current)
    } catch (error) {
      if (ticket === epoch.current) setActivity({ scope, busy: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (ticket === epoch.current) setActivity({ scope, busy: false, error: '' })
  }

  async function analyze(force = false) {
    if (!ready || !master) return
    const ticket = ++epoch.current
    setActivity({ scope, busy: true, error: '' })
    const args = { book_id: bookId, asset_id: master.source.artifactId, stream_id: master.source.range.streamId }
    try {
      const result = readAnalysis(await call('analyze_music', { ...args, force }, { background: true }))
      await observe(ticket, rhythm, result)
    } catch (error) {
      if (ticket === epoch.current) setActivity({ scope, busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function cancel() {
    if (!ready || data.scope !== scope || !data.analysis?.jobId) return
    epoch.current += 1
    try {
      await call('cancel_job', { book_id: bookId, job_id: data.analysis.jobId }, { background: true })
      await load()
    } catch (error) {
      setActivity({ scope, busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { rhythm, master, analysis, markers, mapped, status, load, save, analyze, cancel,
    stop: () => { epoch.current += 1 },
    busy: !ready || activity.scope === scope && activity.busy,
    error: activity.scope === scope ? activity.error || data.analysis?.error || '' : '',
  }
}

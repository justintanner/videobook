import { useCallback, useEffect, useRef, useState } from 'react'
import { applyCaptionEdits, CaptionEditError, type CaptionEdit } from '../../server/src/captions/edits'
import type { CaptionDocument } from '../../server/src/captions/model'
import type { ChatExecution } from './chat-turns'
import {
  activeSubtitleJobIds,
  parseSubtitlesRead,
  parseSubtitlesRender,
  subtitlesPreparesBeforeRender,
  subtitlesRenderBlocker,
  subtitlesRenderQueuedMessage,
  subtitlesToolError,
  type SubtitleRenderOutput,
  type SubtitlesRead,
} from './subtitles-model'

export type SubtitleCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean; chat?: ChatExecution }) => Promise<unknown>

export interface SubtitleTarget {
  artifactId: string
  kind: 'video' | 'final'
  label: string
  mediaUrl: string
  address: string | null
  notebookId: string | null
}

export type SubtitleSaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
export type SubtitleResolution = 'reseed' | 'realign' | 'keep_timings' | 'discard'

export interface SubtitleEditorState {
  target: SubtitleTarget | null
  language: string
  loading: boolean
  read: SubtitlesRead | null
  document: CaptionDocument | null
  revision: string | null
  save: SubtitleSaveState
  saveError: string | null
  conflictRevision: string | null
  error: string | null
  past: CaptionDocument[]
  future: CaptionDocument[]
  coalesceKey: string | null
  preparing: boolean
  renderQueued: boolean
  rendering: boolean
  output: SubtitleRenderOutput
}

export interface SubtitleRenderOutcome {
  ok: boolean
  message: string
}

const EMPTY: SubtitleEditorState = {
  target: null,
  language: 'original',
  loading: false,
  read: null,
  document: null,
  revision: null,
  save: 'saved',
  saveError: null,
  conflictRevision: null,
  error: null,
  past: [],
  future: [],
  coalesceKey: null,
  preparing: false,
  renderQueued: false,
  rendering: false,
  output: 'new',
}

const AUTOSAVE_MS = 700
const POLL_MS = 1000
const SETTLE_MS = 200
const HISTORY_LIMIT = 100

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function busy(read: SubtitlesRead | null): boolean {
  if (!read) return false
  return read.status === 'preparing' || Object.values(read.components).some((component) => component.status === 'queued' || component.status === 'running')
}

function withRead(current: SubtitleEditorState, read: SubtitlesRead): SubtitleEditorState {
  const keepLocal = current.document !== null && current.save !== 'saved'
  if (keepLocal) return { ...current, read, loading: false }
  return {
    ...current,
    read,
    loading: false,
    document: read.document ?? null,
    revision: read.draft?.revision ?? null,
    past: read.draft?.revision === current.revision ? current.past : [],
    future: read.draft?.revision === current.revision ? current.future : [],
  }
}

export function useSubtitleEditor(options: { bookId: string | null; ready: boolean; call: SubtitleCall }) {
  const { bookId, ready, call } = options
  const [state, setState] = useState<SubtitleEditorState>(EMPTY)
  const stateRef = useRef<SubtitleEditorState>(EMPTY)
  const epoch = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saving = useRef<Promise<boolean> | null>(null)
  const renderRequest = useRef<{ revision: string; output: SubtitleRenderOutput; id: string } | null>(null)

  const commit = useCallback((update: (current: SubtitleEditorState) => SubtitleEditorState) => {
    const next = update(stateRef.current)
    stateRef.current = next
    setState(next)
    return next
  }, [])

  useEffect(() => () => {
    epoch.current += 1
    if (saveTimer.current) clearTimeout(saveTimer.current)
  }, [])

  const baseArgs = useCallback(() => {
    const current = stateRef.current
    return { book_id: bookId, asset_id: current.target?.artifactId, language: current.language }
  }, [bookId])

  const fetchRead = useCallback(async (): Promise<SubtitlesRead> => {
    return parseSubtitlesRead(await call('caption_video', { ...baseArgs(), detail: 'full' }, { background: true }))
  }, [baseArgs, call])

  const observe = useCallback(async (ticket: number) => {
    while (ticket === epoch.current && busy(stateRef.current.read)) {
      await wait(POLL_MS)
      if (ticket !== epoch.current) return
      try {
        const read = await fetchRead()
        if (ticket !== epoch.current) return
        commit((current) => withRead({ ...current, preparing: busy(read) }, read))
      } catch (error) {
        if (ticket === epoch.current) commit((current) => ({ ...current, preparing: false, error: subtitlesToolError(error).message }))
        return
      }
    }
    if (ticket === epoch.current) commit((current) => ({ ...current, preparing: false }))
  }, [commit, fetchRead])

  const prepare = useCallback(async (force: string[] = []) => {
    if (!ready || !bookId || !stateRef.current.target) return
    const ticket = epoch.current
    commit((current) => ({ ...current, preparing: true, error: null }))
    try {
      const read = parseSubtitlesRead(await call('caption_video', { ...baseArgs(), op: 'prepare', detail: 'full', force }, { background: true }))
      if (ticket !== epoch.current) return
      commit((current) => withRead({ ...current, preparing: busy(read) }, read))
      await observe(ticket)
    } catch (error) {
      if (ticket === epoch.current) commit((current) => ({ ...current, preparing: false, error: subtitlesToolError(error).message }))
    }
  }, [baseArgs, bookId, call, commit, observe, ready])

  const load = useCallback(async (ticket: number, autoPrepare: boolean) => {
    try {
      const read = await fetchRead()
      if (ticket !== epoch.current) return
      commit((current) => withRead({ ...current, preparing: busy(read) }, read))
      if (autoPrepare && read.status === 'needs_prepare' && read.paid_work.length === 0) {
        await prepare()
        return
      }
      await observe(ticket)
    } catch (error) {
      if (ticket === epoch.current) commit((current) => ({ ...current, loading: false, error: subtitlesToolError(error).message }))
    }
  }, [commit, fetchRead, observe, prepare])

  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current) {
      await saving.current
      return stateRef.current.save === 'saved' ? true : save()
    }
    const current = stateRef.current
    if (!current.document || !current.revision || current.save === 'saved' || current.save === 'conflict') return current.save === 'saved'
    const snapshot = current.document
    const run = (async () => {
      commit((value) => ({ ...value, save: 'saving' }))
      try {
        const result = await call('caption_video', { ...baseArgs(), op: 'update', expected_revision: current.revision, document: snapshot }, { background: true }) as { revision?: unknown }
        const revision = typeof result.revision === 'string' ? result.revision : current.revision
        const latest = commit((value) => ({
          ...value,
          revision,
          save: value.document === snapshot ? 'saved' : 'dirty',
          saveError: null,
        }))
        return latest.save === 'saved'
      } catch (error) {
        const failure = subtitlesToolError(error)
        commit((value) => failure.status === 'conflict'
          ? { ...value, save: 'conflict', conflictRevision: failure.revision, saveError: failure.message }
          : { ...value, save: 'error', saveError: failure.message })
        return false
      }
    })()
    saving.current = run
    try {
      return await run
    } finally {
      saving.current = null
    }
  }, [baseArgs, call, commit])

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void save()
    }, AUTOSAVE_MS)
  }, [save])

  const flush = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const ok = await save()
    if (stateRef.current.save === 'dirty') return save()
    return ok
  }, [save])

  const open = useCallback((target: SubtitleTarget, language = 'original') => {
    epoch.current += 1
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    renderRequest.current = null
    commit(() => ({ ...EMPTY, target, language, loading: true }))
    void load(epoch.current, true)
  }, [commit, load])

  const close = useCallback(() => {
    void flush()
    epoch.current += 1
    renderRequest.current = null
    commit(() => EMPTY)
  }, [commit, flush])

  const setLanguage = useCallback(async (language: string) => {
    const target = stateRef.current.target
    if (!target || language === stateRef.current.language) return
    await flush()
    open(target, language)
  }, [flush, open])

  const edit = useCallback((edits: CaptionEdit[], coalesceKey: string | null = null): boolean => {
    const current = stateRef.current
    if (!current.document || current.save === 'conflict') return false
    let next: CaptionDocument
    try {
      next = applyCaptionEdits(current.document, edits)
    } catch (error) {
      if (!(error instanceof CaptionEditError)) throw error
      commit((value) => ({ ...value, error: error.message }))
      return false
    }
    const coalesce = coalesceKey !== null && coalesceKey === current.coalesceKey
    commit((value) => ({
      ...value,
      document: next,
      past: coalesce ? value.past : [...value.past, current.document!].slice(-HISTORY_LIMIT),
      future: [],
      coalesceKey,
      save: 'dirty',
      error: null,
    }))
    scheduleSave()
    return true
  }, [commit, scheduleSave])

  const step = useCallback((direction: 'undo' | 'redo') => {
    const current = stateRef.current
    const source = direction === 'undo' ? current.past : current.future
    const target = source.at(-1)
    if (!target || !current.document || current.save === 'conflict') return
    commit((value) => ({
      ...value,
      document: target,
      past: direction === 'undo' ? value.past.slice(0, -1) : [...value.past, current.document!],
      future: direction === 'undo' ? [...value.future, current.document!] : value.future.slice(0, -1),
      coalesceKey: null,
      save: 'dirty',
    }))
    scheduleSave()
  }, [commit, scheduleSave])

  const reload = useCallback(async () => {
    const ticket = epoch.current
    commit((current) => ({ ...current, save: 'saved', conflictRevision: null, saveError: null, past: [], future: [], loading: true }))
    await load(ticket, false)
  }, [commit, load])

  const keepMine = useCallback(async () => {
    const revision = stateRef.current.conflictRevision
    if (!revision) return
    commit((current) => ({ ...current, revision, save: 'dirty', conflictRevision: null, saveError: null }))
    await save()
  }, [commit, save])

  const resolve = useCallback(async (resolution: SubtitleResolution) => {
    if (!(await flush())) return
    const current = stateRef.current
    try {
      await call('caption_video', { ...baseArgs(), op: 'update', expected_revision: current.revision, resolve: resolution }, { background: true })
      await reload()
    } catch (error) {
      commit((value) => ({ ...value, error: subtitlesToolError(error).message }))
    }
  }, [baseArgs, call, commit, flush, reload])

  const cancelPreparation = useCallback(async () => {
    for (const jobId of activeSubtitleJobIds(stateRef.current.read)) {
      await call('cancel_job', { book_id: bookId, job_id: jobId }, { background: true }).catch(() => undefined)
    }
    await reload()
  }, [bookId, call, reload])

  const setOutput = useCallback((output: SubtitleRenderOutput) => {
    commit((value) => ({ ...value, output }))
  }, [commit])

  const settlePreparation = useCallback(async (ticket: number) => {
    if (stateRef.current.read?.status === 'needs_prepare') await prepare()
    while (ticket === epoch.current && stateRef.current.preparing) await wait(SETTLE_MS)
  }, [prepare])

  const prepareBeforeRender = useCallback(async (ticket: number): Promise<SubtitleRenderOutcome | null> => {
    if (!subtitlesPreparesBeforeRender(stateRef.current.read)) return null
    commit((value) => ({ ...value, renderQueued: true, error: null }))
    await settlePreparation(ticket)
    if (ticket !== epoch.current) return { ok: false, message: 'The subtitles closed before they were ready.' }
    const latest = commit((value) => ({ ...value, renderQueued: false }))
    if (subtitlesPreparesBeforeRender(latest.read)) return { ok: false, message: 'Preparation stopped, so nothing was rendered.' }
    const blocker = subtitlesRenderBlocker(latest.read, latest.document, latest.save === 'conflict')
    return blocker ? { ok: false, message: latest.error ?? blocker } : null
  }, [commit, settlePreparation])

  const render = useCallback(async (chat?: ChatExecution): Promise<SubtitleRenderOutcome> => {
    const ticket = epoch.current
    const unprepared = await prepareBeforeRender(ticket)
    if (unprepared) return unprepared
    if (!(await flush())) return { ok: false, message: stateRef.current.saveError ?? 'Save the subtitles before rendering.' }
    const current = stateRef.current
    if (!current.target || !current.revision || !current.read) return { ok: false, message: 'The subtitles are not ready to render.' }
    const output = current.output
    const previous = renderRequest.current
    const requestId = previous?.revision === current.revision && previous.output === output ? previous.id : crypto.randomUUID()
    renderRequest.current = { revision: current.revision, output, id: requestId }
    commit((value) => ({ ...value, rendering: true, error: null }))
    try {
      parseSubtitlesRender(await call('caption_video', {
        ...baseArgs(),
        op: 'render',
        output,
        notebook_id: current.target.notebookId ?? undefined,
        expected_revision: current.revision,
        source_hash: current.read.source.media_hash,
        request_id: requestId,
      }, { chat }))
      return { ok: true, message: subtitlesRenderQueuedMessage(output, current.target) }
    } catch (error) {
      const failure = subtitlesToolError(error)
      if (failure.status === 'conflict') commit((value) => ({ ...value, save: 'conflict', conflictRevision: failure.revision, saveError: failure.message }))
      return { ok: false, message: failure.message }
    } finally {
      if (ticket === epoch.current) commit((value) => ({ ...value, rendering: false }))
    }
  }, [baseArgs, call, commit, flush, prepareBeforeRender])

  return {
    state,
    open,
    close,
    setLanguage,
    prepare,
    edit,
    undo: useCallback(() => step('undo'), [step]),
    redo: useCallback(() => step('redo'), [step]),
    reload,
    keepMine,
    resolve,
    cancelPreparation,
    setOutput,
    render,
    flush,
  }
}

export type SubtitleEditor = ReturnType<typeof useSubtitleEditor>

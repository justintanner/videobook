import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphicsEdit } from '../../server/src/graphics/edits'
import type { GraphicsDocument } from '../../server/src/graphics/model'
import type { ChatExecution } from './chat-turns'
import {
  editGraphicsHistory,
  graphicsOpenEdits,
  graphicsRenderQueuedMessage,
  graphicsToolError,
  parseGraphicsRead,
  parseGraphicsRender,
  stepGraphicsHistory,
  type GraphicsHistory,
  type GraphicsRead,
  type GraphicsRenderOutput,
  type GraphicsTarget,
} from './graphics-model'

type GraphicsCall = (tool: string, args: Record<string, unknown>, options?: { background?: boolean; chat?: ChatExecution }) => Promise<unknown>

export type GraphicsSaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export interface GraphicsEditorState {
  target: GraphicsTarget | null
  loading: boolean
  read: GraphicsRead | null
  document: GraphicsDocument | null
  revision: string | null
  save: GraphicsSaveState
  saveError: string | null
  conflictRevision: string | null
  error: string | null
  past: GraphicsDocument[]
  future: GraphicsDocument[]
  coalesceKey: string | null
  rendering: boolean
  output: GraphicsRenderOutput
}

export interface GraphicsRenderOutcome {
  ok: boolean
  message: string
}

const EMPTY: GraphicsEditorState = {
  target: null,
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
  rendering: false,
  output: 'new',
}

const AUTOSAVE_MS = 700
const START_POLL_MS = 500
const START_POLLS = 8

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withRead(current: GraphicsEditorState, read: GraphicsRead): GraphicsEditorState {
  if (current.document !== null && current.save !== 'saved') return { ...current, read, loading: false }
  const sameRevision = read.revision === current.revision
  return {
    ...current,
    read,
    loading: false,
    document: read.document,
    revision: read.revision,
    past: sameRevision ? current.past : [],
    future: sameRevision ? current.future : [],
  }
}

function historyOf(state: GraphicsEditorState): GraphicsHistory | null {
  return state.document ? { document: state.document, past: state.past, future: state.future, coalesceKey: state.coalesceKey } : null
}

function missingImages(state: GraphicsEditorState): boolean {
  const known = state.read?.images ?? {}
  return Boolean(state.document?.layers.some((layer) => layer.kind === 'image' && !known[layer.artifactId]))
}

export function useGraphicsEditor(options: { bookId: string | null; ready: boolean; call: GraphicsCall }) {
  const { bookId, ready, call } = options
  const [state, setState] = useState<GraphicsEditorState>(EMPTY)
  const stateRef = useRef<GraphicsEditorState>(EMPTY)
  const epoch = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saving = useRef<Promise<boolean> | null>(null)
  const renderRequest = useRef<{ revision: string; output: GraphicsRenderOutput; id: string } | null>(null)

  const commit = useCallback((update: (current: GraphicsEditorState) => GraphicsEditorState) => {
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
    const target = stateRef.current.target
    return { book_id: bookId, asset_id: target?.artifactId, ...(target?.notebookId ? { notebook_id: target.notebookId } : {}) }
  }, [bookId])

  const fetchRead = useCallback(async (): Promise<GraphicsRead> => {
    return parseGraphicsRead(await call('video_graphics', baseArgs(), { background: true }))
  }, [baseArgs, call])

  const refreshImages = useCallback(async (ticket: number) => {
    try {
      const read = await fetchRead()
      if (ticket === epoch.current) commit((current) => (current.read ? { ...current, read: { ...current.read, images: read.images } } : current))
    } catch {
      return
    }
  }, [commit, fetchRead])

  const save = useCallback(async (): Promise<boolean> => {
    if (saving.current) {
      await saving.current
      return stateRef.current.save === 'saved' ? true : save()
    }
    const current = stateRef.current
    if (!current.document || !current.revision || current.save === 'saved' || current.save === 'conflict') return current.save === 'saved'
    const snapshot = current.document
    const ticket = epoch.current
    const run = (async () => {
      commit((value) => ({ ...value, save: 'saving' }))
      try {
        const result = await call('video_graphics', { ...baseArgs(), op: 'update', expected_revision: current.revision, document: snapshot }, { background: true }) as { revision?: unknown }
        if (ticket !== epoch.current) return false
        const revision = typeof result.revision === 'string' ? result.revision : current.revision
        const latest = commit((value) => ({ ...value, revision, save: value.document === snapshot ? 'saved' : 'dirty', saveError: null }))
        if (missingImages(latest)) void refreshImages(ticket)
        return latest.save === 'saved'
      } catch (error) {
        if (ticket !== epoch.current) return false
        const failure = graphicsToolError(error)
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
  }, [baseArgs, call, commit, refreshImages])

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

  const applyHistory = useCallback((history: GraphicsHistory) => {
    commit((value) => ({ ...value, document: history.document, past: history.past, future: history.future, coalesceKey: history.coalesceKey, save: 'dirty', error: null }))
    scheduleSave()
  }, [commit, scheduleSave])

  const edit = useCallback((edits: GraphicsEdit[], coalesceKey: string | null = null): boolean => {
    const current = stateRef.current
    const history = historyOf(current)
    if (!history || current.save === 'conflict' || current.rendering) return false
    const result = editGraphicsHistory(history, edits, coalesceKey)
    if (!result.ok) {
      commit((value) => ({ ...value, error: result.message }))
      return false
    }
    if (result.history !== history) applyHistory(result.history)
    return true
  }, [applyHistory, commit])

  const step = useCallback((direction: 'undo' | 'redo') => {
    const current = stateRef.current
    const history = historyOf(current)
    if (!history || current.save === 'conflict' || current.rendering) return
    const next = stepGraphicsHistory(history, direction)
    if (next) applyHistory(next)
  }, [applyHistory])

  const load = useCallback(async (ticket: number) => {
    try {
      const read = await fetchRead()
      if (ticket !== epoch.current) return
      const loaded = commit((current) => withRead(current, read))
      const openEdits = loaded.document && loaded.target ? graphicsOpenEdits(loaded.document, loaded.target) : []
      if (openEdits.length > 0) edit(openEdits)
    } catch (error) {
      if (ticket === epoch.current) commit((current) => ({ ...current, loading: false, error: graphicsToolError(error).message }))
    }
  }, [commit, edit, fetchRead])

  const open = useCallback((target: GraphicsTarget) => {
    epoch.current += 1
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    renderRequest.current = null
    commit(() => ({ ...EMPTY, target, loading: true }))
    void load(epoch.current)
  }, [commit, load])

  const close = useCallback(() => {
    void flush()
    epoch.current += 1
    renderRequest.current = null
    commit(() => EMPTY)
  }, [commit, flush])

  const reload = useCallback(async () => {
    const ticket = epoch.current
    commit((current) => ({ ...current, target: current.target ? { ...current.target, image: null, text: null } : null, save: 'saved', conflictRevision: null, saveError: null, past: [], future: [], loading: true }))
    await load(ticket)
  }, [commit, load])

  const keepMine = useCallback(async () => {
    const revision = stateRef.current.conflictRevision
    if (!revision) return
    commit((current) => ({ ...current, revision, save: 'dirty', conflictRevision: null, saveError: null }))
    await save()
  }, [commit, save])

  const setOutput = useCallback((output: GraphicsRenderOutput) => {
    commit((value) => ({ ...value, output }))
  }, [commit])

  const awaitStart = useCallback(async (ticket: number, requestId: string): Promise<string | null> => {
    for (let poll = 0; poll < START_POLLS && ticket === epoch.current; poll += 1) {
      const render = (await fetchRead().catch(() => null))?.render
      if (!render || render.request_id !== requestId) return null
      if (render.status === 'failed') return render.error ?? 'The render failed.'
      if (render.status !== 'queued') return null
      await wait(START_POLL_MS)
    }
    return null
  }, [fetchRead])

  const render = useCallback(async (chat?: ChatExecution): Promise<GraphicsRenderOutcome> => {
    const ticket = epoch.current
    if (!(await flush())) return { ok: false, message: stateRef.current.saveError ?? 'Save the graphics before rendering.' }
    const current = stateRef.current
    if (!ready || !current.target || !current.revision || !current.read) return { ok: false, message: 'The graphics are not ready to render.' }
    const output = current.output
    const previous = renderRequest.current
    const requestId = previous?.revision === current.revision && previous.output === output ? previous.id : crypto.randomUUID()
    renderRequest.current = { revision: current.revision, output, id: requestId }
    commit((value) => ({ ...value, rendering: true, error: null }))
    try {
      const queued = parseGraphicsRender(await call('video_graphics', {
        ...baseArgs(),
        op: 'render',
        output,
        expected_revision: current.revision,
        source_hash: current.read.source.source_hash,
        request_id: requestId,
      }, { chat }))
      const failure = queued.status === 'failed' ? queued.error ?? 'The render failed.' : await awaitStart(ticket, requestId)
      if (failure) return { ok: false, message: failure }
      return { ok: true, message: graphicsRenderQueuedMessage(output, current.target) }
    } catch (error) {
      const failure = graphicsToolError(error)
      if (failure.status === 'conflict') commit((value) => ({ ...value, save: 'conflict', conflictRevision: failure.revision, saveError: failure.message }))
      return { ok: false, message: failure.message }
    } finally {
      if (ticket === epoch.current) commit((value) => ({ ...value, rendering: false }))
    }
  }, [awaitStart, baseArgs, call, commit, flush, ready])

  return {
    state,
    open,
    close,
    edit,
    undo: useCallback(() => step('undo'), [step]),
    redo: useCallback(() => step('redo'), [step]),
    reload,
    keepMine,
    setOutput,
    render,
    flush,
  }
}

export type GraphicsEditor = ReturnType<typeof useGraphicsEditor>

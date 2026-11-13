import { graphicsAspectChanged, ORIGINAL_GRAPHICS_FRAME, type GraphicsFraming } from '../../server/src/graphics/frame'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphicsEdit } from '../../server/src/graphics/edits'
import type { GraphicsRect } from '../../server/src/graphics/layout'
import type { GraphicsDocument, GraphicsTextSlot } from '../../server/src/graphics/model'
import { GRAPHICS_SUGGEST_SLOTS, type GraphicsSuggestKind, type GraphicsSuggestLanguage } from '../../server/src/graphics/slots'
import type { WatermarkPlatform } from '../../server/src/watermark-platform'
import type { ChatExecution } from './chat-turns'
import {
  editGraphicsHistory,
  editGraphicsFrame,
  graphicsEffectiveFrame,
  graphicsClearSpotMessage,
  graphicsOpenEdits,
  graphicsRenderQueuedMessage,
  graphicsSlotText,
  graphicsTemplateMessage,
  graphicsToolError,
  graphicsWatermarkSwitchEdits,
  parseGraphicsPlacement,
  parseGraphicsRead,
  parseGraphicsRender,
  parseGraphicsSuggestions,
  stepGraphicsHistory,
  type GraphicsHistory,
  type GraphicsSnapshot,
  type GraphicsRead,
  type GraphicsRenderOutput,
  type GraphicsSuggestionList,
  type GraphicsSuggestionLists,
  type GraphicsTarget,
  type GraphicsTemplateChoice,
  type GraphicsTemplateOp,
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
  frame: GraphicsFraming
  past: GraphicsSnapshot[]
  future: GraphicsSnapshot[]
  coalesceKey: string | null
  rendering: boolean
  output: GraphicsRenderOutput
  subtitleLanguage?: string | null
  suggestions: GraphicsSuggestionLists
}

export interface GraphicsRenderOutcome {
  ok: boolean
  message: string
}

export type GraphicsTemplateOutcome = GraphicsRenderOutcome

interface GraphicsClearSpotRequest {
  layerId: string
  box: GraphicsRect
  block: GraphicsRect
  avoid: GraphicsRect[]
  detect: boolean
}

const EMPTY: GraphicsEditorState = {
  target: null,
  loading: false,
  read: null,
  document: null,
  frame: ORIGINAL_GRAPHICS_FRAME,
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
  suggestions: {},
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
    frame: read.frame,
    revision: read.revision,
    past: sameRevision ? current.past : [],
    future: sameRevision ? current.future : [],
  }
}

function historyOf(state: GraphicsEditorState): GraphicsHistory | null {
  return state.document ? { document: state.document, frame: state.frame, past: state.past, future: state.future, coalesceKey: state.coalesceKey } : null
}

function defaultOutput(target: GraphicsTarget): GraphicsRenderOutput {
  return target.watermark && target.kind === 'video' ? 'replace' : 'new'
}

function onceOnly(target: GraphicsTarget | null): GraphicsTarget | null {
  if (!target) return null
  return { ...target, image: null, text: null, watermark: target.watermark && { ...target.watermark, handle: null, includeQr: null } }
}

function withPlatform(state: GraphicsEditorState, platform: WatermarkPlatform): GraphicsEditorState {
  const target = state.target
  if (!target?.watermark) return state
  return { ...state, target: { ...target, watermark: { ...target.watermark, platform } }, loading: true }
}

function withSuggestions(state: GraphicsEditorState, slot: GraphicsTextSlot, list: GraphicsSuggestionList | null): GraphicsEditorState {
  const suggestions = { ...state.suggestions }
  if (list) suggestions[slot] = list
  else delete suggestions[slot]
  return { ...state, suggestions }
}

function settleSuggestions(state: GraphicsEditorState, slot: GraphicsTextSlot, requestId: string, patch: Pick<GraphicsSuggestionList, 'status' | 'options' | 'message'>): GraphicsEditorState {
  const list = state.suggestions[slot]
  return list?.requestId === requestId ? withSuggestions(state, slot, { ...list, ...patch }) : state
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
  const renderRequest = useRef<{ revision: string; output: GraphicsRenderOutput; id: string; subtitles: string | null } | null>(null)

  const commit = useCallback((update: (current: GraphicsEditorState) => GraphicsEditorState) => {
    const updated = update(stateRef.current)
    const changedAspect = updated.read && graphicsAspectChanged(updated.read.source, graphicsEffectiveFrame(updated.frame, updated.read, updated.subtitleLanguage))
    const next = changedAspect && updated.output === 'replace' ? { ...updated, output: 'new' as const } : updated
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
    return {
      book_id: bookId,
      asset_id: target?.artifactId,
      ...(target?.notebookId ? { notebook_id: target.notebookId } : {}),
      ...(target?.watermark ? { watermark: true, platform: target.watermark.platform } : {}),
    }
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
    if (!ready) return false
    if (saving.current) {
      await saving.current
      return stateRef.current.save === 'saved' ? true : save()
    }
    const current = stateRef.current
    if (!current.document || !current.revision || current.save === 'saved' || current.save === 'conflict') return current.save === 'saved'
    const snapshot = current.document
    const frame = current.frame
    const ticket = epoch.current
    const run = (async () => {
      commit((value) => ({ ...value, save: 'saving' }))
      try {
        const result = await call('video_graphics', { ...baseArgs(), op: 'update', expected_revision: current.revision, document: snapshot, frame }, { background: true }) as { revision?: unknown }
        if (ticket !== epoch.current) return false
        const revision = typeof result.revision === 'string' ? result.revision : current.revision
        const latest = commit((value) => ({ ...value, revision, save: value.document === snapshot && value.frame === frame ? 'saved' : 'dirty', saveError: null }))
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
  }, [baseArgs, call, commit, refreshImages, ready])

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
    commit((value) => ({ ...value, document: history.document, frame: history.frame ?? ORIGINAL_GRAPHICS_FRAME, past: history.past, future: history.future, coalesceKey: history.coalesceKey, save: 'dirty', error: null }))
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
      const openEdits = loaded.document && loaded.target ? graphicsOpenEdits(loaded.document, loaded.target, loaded.read) : []
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
    commit(() => ({ ...EMPTY, target, loading: true, output: defaultOutput(target) }))
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
    commit((current) => ({ ...current, target: onceOnly(current.target), save: 'saved', conflictRevision: null, saveError: null, past: [], future: [], loading: true }))
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
    const effective = graphicsEffectiveFrame(current.frame, current.read, current.subtitleLanguage)
    const output = graphicsAspectChanged(current.read.source, effective) ? 'new' : current.output
    const available = current.read.subtitles ?? []
    const language = current.subtitleLanguage === undefined ? (available.find((draft) => draft.language === 'original') ?? available[0])?.language : current.subtitleLanguage
    const subtitle = available.find((draft) => draft.language === language)
    const subtitles = language ? `${language}:${subtitle?.revision ?? "missing"}` : null
    const previous = renderRequest.current
    const requestId = previous?.revision === current.revision && previous.output === output && previous.subtitles === subtitles ? previous.id : crypto.randomUUID()
    renderRequest.current = { revision: current.revision, output, id: requestId, subtitles }
    commit((value) => ({ ...value, rendering: true, error: null }))
    try {
      const queued = parseGraphicsRender(await call('video_graphics', {
        ...baseArgs(),
        op: 'render',
        ...(language ? { with_subtitles: language, subtitles_revision: subtitle?.revision } : {}),
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

  const templateAction = useCallback(async (op: GraphicsTemplateOp, args: () => Record<string, unknown>, message: { name?: string; overwrite?: boolean } = {}): Promise<GraphicsTemplateOutcome> => {
    const ticket = epoch.current
    if (!ready || !stateRef.current.target) return { ok: false, message: 'The graphics are not ready yet.' }
    if (!(await flush())) return { ok: false, message: stateRef.current.saveError ?? 'Save the graphics first.' }
    const platform = stateRef.current.target?.watermark?.platform
    try {
      const result = await call('video_graphics', { ...baseArgs(), op, ...args() }, { background: true })
      const read = await fetchRead().catch(() => null)
      if (read && ticket === epoch.current) commit((current) => withRead(current, read))
      return { ok: true, message: graphicsTemplateMessage(op, result, { ...message, ...(platform ? { platform } : {}) }) }
    } catch (error) {
      return { ok: false, message: graphicsToolError(error).message }
    }
  }, [baseArgs, call, commit, fetchRead, flush, ready])

  const saveTemplate = useCallback((name: string | null, templateId: string | null = null) => templateAction(
    'save_template',
    () => ({ expected_revision: stateRef.current.revision, ...(name === null ? {} : { name }), ...(templateId ? { template_id: templateId } : {}) }),
    { overwrite: templateId !== null },
  ), [templateAction])

  const renameTemplate = useCallback((templateId: string, name: string) => templateAction('rename_template', () => ({ template_id: templateId, name })), [templateAction])

  const deleteTemplate = useCallback((templateId: string) => templateAction('delete_template', () => ({ template_id: templateId })), [templateAction])

  const setDefaultTemplate = useCallback((choice: Pick<GraphicsTemplateChoice, 'id' | 'name'>) => templateAction(
    'set_default_template',
    () => ({ template_id: choice.id }),
    { name: choice.name },
  ), [templateAction])

  const copyTemplates = useCallback((fromBookId: string) => templateAction('copy_templates', () => ({ from_book: fromBookId })), [templateAction])

  const saveWatermark = useCallback(() => templateAction('save_watermark', () => ({ expected_revision: stateRef.current.revision })), [templateAction])

  const resetWatermark = useCallback(() => templateAction('set_watermark_template', () => ({ template_id: null })), [templateAction])

  const suggest = useCallback(async (kind: GraphicsSuggestKind, language: GraphicsSuggestLanguage) => {
    const current = stateRef.current
    if (!ready || !current.target || !current.document) return
    const slot = GRAPHICS_SUGGEST_SLOTS[kind]
    const requestId = crypto.randomUUID()
    const text = kind === 'translate' ? graphicsSlotText(current.document, 'headline')?.trim() ?? '' : ''
    const list: GraphicsSuggestionList = { requestId, kind, language, status: 'loading', options: [], message: null }
    if (kind === 'translate' && !text) {
      commit((value) => withSuggestions(value, slot, { ...list, status: 'error', message: 'Type or pick a headline first.' }))
      return
    }
    commit((value) => withSuggestions(value, slot, list))
    try {
      const result = parseGraphicsSuggestions(await call('video_graphics', { ...baseArgs(), op: 'suggest', kind, language, ...(text ? { text } : {}) }))
      commit((value) => settleSuggestions(value, slot, requestId, { status: 'ready', options: result.options, message: null }))
    } catch (error) {
      commit((value) => settleSuggestions(value, slot, requestId, { status: 'error', options: [], message: graphicsToolError(error).message }))
    }
  }, [baseArgs, call, commit, ready])

  const findClearSpot = useCallback(async (request: GraphicsClearSpotRequest): Promise<GraphicsTemplateOutcome> => {
    const ticket = epoch.current
    if (!ready || !stateRef.current.target) return { ok: false, message: 'The graphics are not ready yet.' }
    if (!(await flush())) return { ok: false, message: stateRef.current.saveError ?? 'Save the graphics first.' }
    try {
      const args = { ...baseArgs(), op: request.detect ? 'detect_regions' : 'check_placement', layer_id: request.layerId, box: request.box, block: request.block, avoid: request.avoid }
      const result = parseGraphicsPlacement(await call('video_graphics', args, request.detect ? undefined : { background: true }))
      if (ticket !== epoch.current) return { ok: false, message: 'The editor moved on to other graphics.' }
      const regions = result.regions
      if (regions) commit((value) => (value.read ? { ...value, read: { ...value.read, regions } } : value))
      const spot = result.clear_spot
      if (!spot) return { ok: false, message: 'Some frames of this layer are not checked for faces and text yet.' }
      if (spot.moved && !edit([{ op: 'set_position', layer_id: request.layerId, position: spot.position }])) {
        return { ok: false, message: stateRef.current.error ?? 'The layer could not be moved.' }
      }
      return { ok: true, message: graphicsClearSpotMessage(spot) }
    } catch (error) {
      return { ok: false, message: graphicsToolError(error).message }
    }
  }, [baseArgs, call, commit, edit, flush, ready])

  const dismissSuggestions = useCallback((slot: GraphicsTextSlot) => {
    commit((value) => withSuggestions(value, slot, null))
  }, [commit])

  const setPlatform = useCallback(async (platform: WatermarkPlatform) => {
    const current = stateRef.current
    if (!current.target?.watermark || current.target.watermark.platform === platform || current.rendering || current.save === 'conflict') return
    if (!(await flush())) return
    const ticket = epoch.current
    commit((value) => withPlatform(value, platform))
    try {
      const read = await fetchRead()
      if (ticket !== epoch.current) return
      const loaded = commit((value) => withRead(value, read))
      if (read.saved && loaded.document) edit(graphicsWatermarkSwitchEdits(loaded.document, read))
    } catch (error) {
      if (ticket === epoch.current) commit((value) => ({ ...value, loading: false, error: graphicsToolError(error).message }))
    }
  }, [commit, edit, fetchRead, flush])

  return {
    state,
    bookId,
    open,
    close,
    edit,
    undo: useCallback(() => step('undo'), [step]),
    redo: useCallback(() => step('redo'), [step]),
    reload,
    keepMine,
    setOutput,
    setFrame: useCallback((frame: GraphicsFraming, coalesce: string | null = null) => {
      const current = stateRef.current
      const history = historyOf(current)
      if (!history || current.save === 'conflict' || current.rendering) return
      const next = editGraphicsFrame(history, frame, coalesce)
      if (next !== history) applyHistory(next)
      if (current.read && graphicsAspectChanged(current.read.source, frame)) commit((value) => ({ ...value, output: 'new' }))
    }, [applyHistory, commit]),
    setSubtitleLanguage: useCallback((subtitleLanguage: string | null) => { commit((value) => ({ ...value, subtitleLanguage })) }, [commit]),
    render,
    flush,
    saveTemplate,
    renameTemplate,
    deleteTemplate,
    setDefaultTemplate,
    copyTemplates,
    saveWatermark,
    resetWatermark,
    setPlatform,
    suggest,
    dismissSuggestions,
    findClearSpot,
  }
}

export type GraphicsEditor = ReturnType<typeof useGraphicsEditor>

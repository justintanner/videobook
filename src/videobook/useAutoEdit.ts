import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  frameToSeconds,
  secondsToFrame,
  segmentPlanSchema,
  type SegmentPlan,
  type SegmentSource,
} from '../../server/src/auto-edit/plan'
import {
  autoEditAnchorsSchema,
  autoEditCuesSchema,
  autoEditSectionsSchema,
  buildAutoEditPlan,
  DEFAULT_AUTO_EDIT_SECTIONS,
  type AutoEditAnchors,
  type AutoEditCue,
  type AutoEditSections,
} from '../../server/src/auto-edit/style'
import type { ChatExecution } from './chat-turns'

type Call = (tool: string, args: Record<string, unknown>, options?: { background?: boolean; chat?: ChatExecution }) => Promise<unknown>

export interface AutoEditTarget {
  artifactId: string
  label: string
  mediaUrl: string
  address: string | null
  notebookId: string | null
}

export type AutoEditAnalysisPhase =
  | { step: 'idle' }
  | { step: 'estimating' }
  | { step: 'confirm'; usd: number; warnings: string[]; notes: string[]; force: boolean }
  | { step: 'running'; status: 'queued' | 'running'; jobId: number }
  | { step: 'failed'; message: string }
  | { step: 'ready'; summary: string; confidence: 'high' | 'medium' | 'low' }

export interface AutoEditRenderOutcome {
  ok: boolean
  message: string
  cellId?: string
  address?: string
}

const sourceSchema = z.object({
  artifact_id: z.string().min(1),
  label: z.string().nullable(),
  source_hash: z.string().min(1),
  duration: z.number(),
  fps: z.number(),
  frames: z.number(),
  width: z.number(),
  height: z.number(),
  has_audio: z.boolean(),
})

const analysisSchema = z.object({
  status: z.enum(['none', 'queued', 'running', 'ready', 'failed']),
  job_id: z.number().nullable(),
  summary: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
  error: z.string().nullable(),
})

const getSchema = z.object({
  source: sourceSchema,
  draft: z.object({
    revision: z.string().nullable(),
    default: z.boolean(),
    anchors: autoEditAnchorsSchema,
    sections: autoEditSectionsSchema,
  }),
  plan: segmentPlanSchema,
  cues: autoEditCuesSchema,
  changes: z.array(z.string()),
  analysis: analysisSchema,
  analysis_available: z.boolean().optional(),
  last_render: z.object({
    status: z.string(),
    job_id: z.number().nullable(),
    error: z.string().nullable(),
  }).nullable().optional(),
})

const analyzeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('cached'),
    draft: z.object({
      revision: z.string().nullable(),
      default: z.boolean(),
      anchors: autoEditAnchorsSchema,
      sections: autoEditSectionsSchema,
    }),
    plan: segmentPlanSchema,
    cues: autoEditCuesSchema,
    changes: z.array(z.string()),
    analysis: analysisSchema,
    analysis_available: z.boolean().optional(),
  }),
  z.object({
    status: z.enum(['queued', 'running']),
    job_id: z.number(),
  }),
])

const estimateResponseSchema = z.object({
  estimate: z.object({
    usd: z.number().nullable(),
    warnings: z.array(z.string()).default([]),
    notes: z.array(z.string()).default([]),
  }),
})

export type AutoEditSource = z.infer<typeof sourceSchema>

export interface AutoEditState {
  target: AutoEditTarget | null
  bookId: string | null
  loading: boolean
  rendering: boolean
  error: string | null
  source: AutoEditSource | null
  anchors: AutoEditAnchors | null
  sections: AutoEditSections
  plan: SegmentPlan | null
  cues: AutoEditCue[]
  changes: string[]
  analysisAvailable: boolean
  analysisPhase: AutoEditAnalysisPhase
  focusAnchor: 'start' | 'peak' | 'end'
  playheadSeconds: number
}

interface KeptAutoEditDraft {
  sourceHash: string
  serverRevision: string | null
  anchors: AutoEditAnchors
  sections: AutoEditSections
  anchorsDirty: boolean
  sectionsDirty: boolean
}

const EMPTY_STATE: AutoEditState = {
  target: null,
  bookId: null,
  loading: false,
  rendering: false,
  error: null,
  source: null,
  anchors: null,
  sections: { ...DEFAULT_AUTO_EDIT_SECTIONS },
  plan: null,
  cues: [],
  changes: [],
  analysisAvailable: false,
  analysisPhase: { step: 'idle' },
  focusAnchor: 'peak',
  playheadSeconds: 0,
}

const POLL_INTERVAL_MS = 400
const MAX_JOB_POLLS = 1200

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function segmentSourceFrom(source: AutoEditSource): SegmentSource {
  return {
    artifactId: source.artifact_id,
    sourceHash: source.source_hash,
    fps: source.fps,
    frames: Math.max(2, secondsToFrame(source.duration, source.fps)),
    width: source.width,
    height: source.height,
    hasAudio: source.has_audio,
  }
}

function phaseFromAnalysis(analysis: z.infer<typeof analysisSchema>): AutoEditAnalysisPhase {
  if (analysis.status === 'ready' && analysis.summary && analysis.confidence) {
    return { step: 'ready', summary: analysis.summary, confidence: analysis.confidence }
  }
  if ((analysis.status === 'queued' || analysis.status === 'running') && analysis.job_id !== null) {
    return { step: 'running', status: analysis.status, jobId: analysis.job_id }
  }
  if (analysis.status === 'failed') {
    return { step: 'failed', message: analysis.error ?? 'Analysis failed.' }
  }
  return { step: 'idle' }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server response')
  return value as Record<string, unknown>
}

export function useAutoEdit({ bookId, ready, call }: { bookId: string | null; ready: boolean; call: Call }) {
  const [state, setState] = useState<AutoEditState>(EMPTY_STATE)
  const stateRef = useRef<AutoEditState>(EMPTY_STATE)
  const serverRevisionRef = useRef<string | null>(null)
  const lastAnalysisRef = useRef<z.infer<typeof analysisSchema> | null>(null)
  const keptDraftsRef = useRef(new Map<string, KeptAutoEditDraft>())
  const epochRef = useRef(0)

  useEffect(() => () => {
    epochRef.current += 1
  }, [bookId, ready])

  const commit = useCallback((update: (prev: AutoEditState) => AutoEditState): AutoEditState => {
    const next = update(stateRef.current)
    stateRef.current = next
    setState(next)
    return next
  }, [])

  const draftKeyFor = (targetBookId: string, artifactId: string) => `${targetBookId}:${artifactId}`

  const persistKept = useCallback((anchors: AutoEditAnchors, sections: AutoEditSections, flags: { anchorsDirty?: boolean; sectionsDirty?: boolean }) => {
    const current = stateRef.current
    if (!current.bookId || !current.target || !current.source) return
    const key = draftKeyFor(current.bookId, current.target.artifactId)
    const previous = keptDraftsRef.current.get(key)
    keptDraftsRef.current.set(key, {
      sourceHash: current.source.source_hash,
      serverRevision: serverRevisionRef.current,
      anchors,
      sections,
      anchorsDirty: flags.anchorsDirty ?? previous?.anchorsDirty ?? false,
      sectionsDirty: flags.sectionsDirty ?? previous?.sectionsDirty ?? false,
    })
  }, [])

  const pollJob = useCallback(async (targetBookId: string, jobId: number, token: number): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < MAX_JOB_POLLS; attempt += 1) {
      if (epochRef.current !== token) throw new Error('Auto-edit sheet closed.')
      const value = await call('list_jobs', { book_id: targetBookId, job_ids: [jobId] }, { background: true })
      if (epochRef.current !== token) throw new Error('Auto-edit sheet closed.')
      if (!Array.isArray(value) || value.length === 0) throw new Error('The auto-edit job could not be found.')
      const job = recordOf(value[0])
      if (job.state === 'done') return recordOf(job.result ?? {})
      if (job.state === 'failed' || job.state === 'aborted') {
        const message = typeof recordOf(job.error ?? {}).message === 'string'
          ? String(recordOf(job.error ?? {}).message)
          : 'The auto-edit job did not finish.'
        throw new Error(message)
      }
      await wait(POLL_INTERVAL_MS)
    }
    throw new Error('The auto-edit job is still running. Check Jobs and reopen to see its status.')
  }, [call])

  const pollAnalysisJob = useCallback(async (target: AutoEditTarget, targetBookId: string, jobId: number, token: number) => {
    try {
      await pollJob(targetBookId, jobId, token)
      if (epochRef.current !== token || !ready) return
      const got = getSchema.parse(await call('auto_edit', {
        book_id: targetBookId,
        asset_id: target.artifactId,
        ...(target.notebookId ? { notebook_id: target.notebookId } : {}),
        op: 'get',
      }, { background: true }))
      if (epochRef.current !== token) return
      serverRevisionRef.current = got.draft.revision
      lastAnalysisRef.current = got.analysis
      commit((current) => {
        if (!current.source) return current
        const built = buildAutoEditPlan(segmentSourceFrom(got.source), got.draft.anchors, current.sections)
        const key = draftKeyFor(targetBookId, target.artifactId)
        const previous = keptDraftsRef.current.get(key)
        keptDraftsRef.current.set(key, {
          sourceHash: got.source.source_hash,
          serverRevision: got.draft.revision,
          anchors: built.anchors,
          sections: current.sections,
          anchorsDirty: false,
          sectionsDirty: previous?.sectionsDirty ?? false,
        })
        return {
          ...current,
          source: got.source,
          anchors: built.anchors,
          plan: built.plan,
          cues: built.cues,
          changes: built.changes,
          analysisAvailable: got.analysis_available ?? current.analysisAvailable,
          analysisPhase: phaseFromAnalysis(got.analysis),
        }
      })
    } catch (error) {
      if (epochRef.current !== token) return
      const message = error instanceof Error ? error.message : String(error)
      commit((current) => ({ ...current, analysisPhase: { step: 'failed', message } }))
    }
  }, [call, commit, pollJob, ready])

  const open = useCallback((target: AutoEditTarget) => {
    const token = ++epochRef.current
    serverRevisionRef.current = null
    lastAnalysisRef.current = null
    commit(() => ({ ...EMPTY_STATE, target, bookId, loading: true }))
    if (!ready || !bookId) {
      commit((current) => ({ ...current, loading: false, error: 'Connect to Videobook first.' }))
      return
    }
    void (async () => {
      try {
        const got = getSchema.parse(await call('auto_edit', {
          book_id: bookId,
          asset_id: target.artifactId,
          ...(target.notebookId ? { notebook_id: target.notebookId } : {}),
          op: 'get',
        }, { background: true }))
        if (epochRef.current !== token) return
        serverRevisionRef.current = got.draft.revision
        lastAnalysisRef.current = got.analysis
        const key = draftKeyFor(bookId, target.artifactId)
        const kept = keptDraftsRef.current.get(key)
        const matchingKept = kept && kept.sourceHash === got.source.source_hash ? kept : null
        const sameServerRevision = matchingKept !== null && matchingKept.serverRevision === got.draft.revision
        const anchors = sameServerRevision && matchingKept.anchorsDirty ? matchingKept.anchors : got.draft.anchors
        const sections = matchingKept && matchingKept.sectionsDirty ? matchingKept.sections : got.draft.sections
        const built = buildAutoEditPlan(segmentSourceFrom(got.source), anchors, sections)
        const phase = phaseFromAnalysis(got.analysis)
        commit((current) => ({
          ...current,
          loading: false,
          error: null,
          source: got.source,
          anchors: built.anchors,
          sections,
          plan: built.plan,
          cues: built.cues,
          changes: sameServerRevision || matchingKept?.sectionsDirty ? built.changes : got.changes,
          analysisAvailable: got.analysis_available ?? false,
          analysisPhase: phase,
          playheadSeconds: frameToSeconds(built.plan.segments[0]?.startFrame ?? 0, got.source.fps),
        }))
        if (phase.step === 'running') {
          void pollAnalysisJob(target, bookId, phase.jobId, token)
        }
      } catch (error) {
        if (epochRef.current !== token) return
        commit((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    })()
  }, [bookId, call, commit, pollAnalysisJob, ready])

  const close = useCallback(() => {
    epochRef.current += 1
    commit(() => EMPTY_STATE)
  }, [commit])

  const applyDraft = useCallback((
    nextAnchors: AutoEditAnchors,
    nextSections: AutoEditSections,
    flags: { anchorsDirty?: boolean; sectionsDirty?: boolean },
  ) => {
    const current = stateRef.current
    if (!current.source) return null
    const built = buildAutoEditPlan(segmentSourceFrom(current.source), nextAnchors, nextSections)
    persistKept(built.anchors, nextSections, flags)
    commit((value) => ({
      ...value,
      anchors: built.anchors,
      sections: nextSections,
      plan: built.plan,
      cues: built.cues,
      changes: built.changes,
      error: null,
    }))
    return built.anchors
  }, [commit, persistKept])

  const setAnchors = useCallback((updater: (current: AutoEditAnchors, fps: number, duration: number) => AutoEditAnchors) => {
    const current = stateRef.current
    if (!current.anchors || !current.source) return null
    return applyDraft(updater(current.anchors, current.source.fps, current.source.duration), current.sections, { anchorsDirty: true })
  }, [applyDraft])

  const setSection = useCallback((section: keyof AutoEditSections, enabled: boolean) => {
    const current = stateRef.current
    if (!current.anchors || !current.source) return
    applyDraft(current.anchors, { ...current.sections, [section]: enabled }, { sectionsDirty: true })
  }, [applyDraft])

  const setFocusAnchor = useCallback((focusAnchor: 'start' | 'peak' | 'end') => {
    commit((current) => ({ ...current, focusAnchor }))
  }, [commit])

  const setFocusPoint = useCallback((which: 'start' | 'peak' | 'end', point: { x: number; y: number }) => {
    setAnchors((anchors) => ({
      ...anchors,
      focus: { ...anchors.focus, [which]: point },
    }))
  }, [setAnchors])

  const setPlayheadSeconds = useCallback((playheadSeconds: number) => {
    commit((current) => ({ ...current, playheadSeconds }))
  }, [commit])

  const requestAnalysisEstimate = useCallback(async (force = false) => {
    const current = stateRef.current
    const token = epochRef.current
    if (!ready || !bookId || !current.target || !current.analysisAvailable) return
    commit((value) => ({ ...value, analysisPhase: { step: 'estimating' } }))
    try {
      const result = estimateResponseSchema.parse(await call('estimate_cost', {
        calls: [{ tool_name: 'auto_edit', input: { book_id: bookId, asset_id: current.target.artifactId, op: 'analyze' } }],
      }, { background: true }))
      if (epochRef.current !== token) return
      commit((value) => ({
        ...value,
        analysisPhase: {
          step: 'confirm',
          usd: result.estimate.usd ?? 0,
          warnings: result.estimate.warnings,
          notes: result.estimate.notes,
          force,
        },
      }))
    } catch (error) {
      if (epochRef.current !== token) return
      commit((value) => ({
        ...value,
        analysisPhase: { step: 'failed', message: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [bookId, call, commit, ready])

  const dismissAnalysisEstimate = useCallback(() => {
    commit((value) => ({
      ...value,
      analysisPhase: lastAnalysisRef.current ? phaseFromAnalysis(lastAnalysisRef.current) : { step: 'idle' },
    }))
  }, [commit])

  const confirmAnalysis = useCallback(async (force = false) => {
    const current = stateRef.current
    const token = epochRef.current
    if (!ready || !bookId || !current.target) return
    const target = current.target
    commit((value) => ({ ...value, analysisPhase: { step: 'running', status: 'queued', jobId: 0 } }))
    try {
      const response = analyzeSchema.parse(await call('auto_edit', {
        book_id: bookId,
        asset_id: target.artifactId,
        ...(target.notebookId ? { notebook_id: target.notebookId } : {}),
        op: 'analyze',
        ...(force ? { force: true } : {}),
      }, { background: true }))
      if (epochRef.current !== token) return
      if (response.status === 'cached') {
        serverRevisionRef.current = response.draft.revision
        lastAnalysisRef.current = response.analysis
        commit((value) => {
          if (!value.source) return value
          const built = buildAutoEditPlan(segmentSourceFrom(value.source), response.draft.anchors, value.sections)
          const key = draftKeyFor(bookId, target.artifactId)
          const previous = keptDraftsRef.current.get(key)
          keptDraftsRef.current.set(key, {
            sourceHash: value.source.source_hash,
            serverRevision: response.draft.revision,
            anchors: built.anchors,
            sections: value.sections,
            anchorsDirty: false,
            sectionsDirty: previous?.sectionsDirty ?? false,
          })
          return {
            ...value,
            anchors: built.anchors,
            plan: built.plan,
            cues: built.cues,
            changes: built.changes,
            analysisAvailable: response.analysis_available ?? value.analysisAvailable,
            analysisPhase: phaseFromAnalysis(response.analysis),
          }
        })
        return
      }
      commit((value) => ({
        ...value,
        analysisPhase: { step: 'running', status: response.status, jobId: response.job_id },
      }))
      await pollAnalysisJob(target, bookId, response.job_id, token)
    } catch (error) {
      if (epochRef.current !== token) return
      commit((value) => ({
        ...value,
        analysisPhase: { step: 'failed', message: error instanceof Error ? error.message : String(error) },
      }))
    }
  }, [bookId, call, commit, pollAnalysisJob, ready])

  const render = useCallback(async (chat?: ChatExecution): Promise<AutoEditRenderOutcome> => {
    const current = stateRef.current
    const token = epochRef.current
    if (!ready || !bookId || current.bookId !== bookId || !current.target || !current.source || !current.anchors || !current.plan) {
      return { ok: false, message: 'Auto-edit draft is not ready to render.' }
    }
    const target = current.target
    commit((value) => ({ ...value, rendering: true, error: null }))
    try {
      const response = recordOf(await call('auto_edit', {
        book_id: bookId,
        asset_id: target.artifactId,
        ...(target.notebookId ? { notebook_id: target.notebookId } : {}),
        op: 'render',
        source_hash: current.source.source_hash,
        request_id: crypto.randomUUID(),
        anchors: current.anchors,
        sections: current.sections,
      }, { chat }))
      const result = await pollJob(bookId, Number(response.job_id), token)
      const cellId = typeof result.cell_id === 'string' ? result.cell_id : undefined
      const address = typeof result.address === 'string' ? result.address : undefined
      keptDraftsRef.current.delete(draftKeyFor(bookId, target.artifactId))
      return {
        ok: true,
        message: address ? `Auto-edit created as ${address}` : 'Auto-edit render finished',
        cellId,
        address,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (epochRef.current === token) commit((value) => ({ ...value, error: message }))
      return { ok: false, message }
    } finally {
      if (epochRef.current === token) commit((value) => ({ ...value, rendering: false }))
    }
  }, [bookId, call, commit, pollJob, ready])

  return {
    state,
    open,
    close,
    setAnchors,
    setSection,
    setFocusAnchor,
    setFocusPoint,
    setPlayheadSeconds,
    requestAnalysisEstimate,
    dismissAnalysisEstimate,
    confirmAnalysis,
    render,
  }
}

export type AutoEditEditor = ReturnType<typeof useAutoEdit>

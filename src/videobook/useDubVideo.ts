import { useRef, useState } from 'react'
import { DUB_VIDEO_MAX_LANGUAGES, DUB_VIDEO_MODELS, type DubQuality } from '../../server/src/dub-video-contract'
import type { MediaFileToolCall } from './use-media-file-actions'
import { recordValue } from './value-decoders'

type DubDraft = {
  language: string[]
  quality: DubQuality
  lip_sync: boolean
  speakers?: number
}

const defaults: DubDraft = { language: [], quality: 'speed', lip_sync: true }
type Languages = Record<DubQuality, string[]>
type Phase =
  | { step: 'closed' | 'loading' | 'choosing' | 'estimating' | 'submitting' | 'refreshing' }
  | { step: 'quoted'; usd: number }
  | { step: 'failed'; error: string; retry: 'catalog' | 'estimate' | 'refresh' }

export function dubCatalogLanguages(value: unknown): Languages {
  const models = recordValue(value)?.models
  function forQuality(quality: DubQuality): string[] {
    const model = Array.isArray(models) ? models.map(recordValue).find(row => row?.id === DUB_VIDEO_MODELS[quality]) : null
    const option = Array.isArray(model?.options) && model.options.map(recordValue).find(row => row?.name === 'output_language')
    const values = recordValue(option)?.enumValues
    if (!Array.isArray(values) || !values.length || !values.every((v): v is string => typeof v === 'string')) {
      throw new Error('HeyGen Translate languages are unavailable.')
    }
    return values
  }
  return { speed: forQuality('speed'), precision: forQuality('precision') }
}

export function dubEstimateUsd(result: unknown): number {
  const quote = recordValue(recordValue(result)?.estimate)
  if (quote?.source === 'per-unit-table' && typeof quote.usd === 'number' && Number.isFinite(quote.usd) && quote.usd > 0) return quote.usd
  const warning = Array.isArray(quote?.warnings) && quote.warnings.find(item => typeof item === 'string' && item)
  throw new Error(warning || 'The dub price is unavailable.')
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export function useDubVideo(call: MediaFileToolCall | undefined, bookId: string, notebookId: string, cellId: string, onRefresh: () => Promise<unknown>) {
  const [phase, setPhase] = useState<Phase>({ step: 'closed' })
  const [catalog, setCatalog] = useState<Languages>()
  const [draft, setDraft] = useState(defaults)
  const [notice, setNotice] = useState('')
  const request = useRef(0)
  const submitting = useRef(false)
  const available = Boolean(call && bookId && notebookId && cellId)
  const running = phase.step === 'submitting' || phase.step === 'refreshing'
  const input = (choices: DubDraft) => ({ book_id: bookId, notebook_id: notebookId, asset_id: cellId, dynamic_duration: false, ...choices })

  async function open() {
    if (!call || !available || submitting.current) return
    const token = ++request.current
    setDraft(defaults)
    setNotice('')
    if (catalog) {
      setPhase({ step: 'choosing' })
      return
    }
    setPhase({ step: 'loading' })
    try {
      const languages = dubCatalogLanguages(await call('list_generation_models', { media: 'video', operation: 'edit_video' }, { background: true }))
      if (token !== request.current) return
      setCatalog(languages)
      setPhase({ step: 'choosing' })
    } catch (cause) {
      if (token === request.current) setPhase({ step: 'failed', error: message(cause), retry: 'catalog' })
    }
  }

  function close() {
    if (submitting.current) return
    ++request.current
    setPhase({ step: 'closed' })
  }

  async function update(changes: Partial<DubDraft>) {
    if (!call || !available || !catalog || submitting.current) return
    const next = { ...draft, ...changes }
    next.language = next.language.filter(lang => catalog[next.quality].includes(lang))
    if (next.language.length > DUB_VIDEO_MAX_LANGUAGES) return
    setDraft(next)
    const token = ++request.current
    if (!next.language.length) {
      setPhase({ step: 'choosing' })
      return
    }
    setPhase({ step: 'estimating' })
    try {
      const result = await call('estimate_cost', { calls: [{ tool_name: 'dub_video', input: input(next) }] }, { background: true })
      if (token !== request.current) return
      setPhase({ step: 'quoted', usd: dubEstimateUsd(result) })
    } catch (cause) {
      if (token === request.current) setPhase({ step: 'failed', error: message(cause), retry: 'estimate' })
    }
  }

  async function refresh() {
    submitting.current = true
    setPhase({ step: 'refreshing' })
    try {
      await onRefresh()
      setNotice(`Dubbing queued for ${draft.language.join(', ')}.`)
      setPhase({ step: 'closed' })
    } catch (cause) {
      setPhase({ step: 'failed', error: `Dubbing queued. Could not refresh the notebook. ${message(cause)}`, retry: 'refresh' })
    } finally {
      submitting.current = false
    }
  }

  async function confirm() {
    if (!call || !available || phase.step !== 'quoted' || submitting.current) return
    submitting.current = true
    setPhase({ step: 'submitting' })
    try {
      const result = recordValue(await call('dub_video', input(draft)))
      if (result?.status !== 'enqueued') throw new Error('The server did not confirm the dub. Check the notebook before trying again.')
    } catch (cause) {
      submitting.current = false
      setPhase({ step: 'failed', error: message(cause), retry: 'estimate' })
      return
    }
    await refresh()
  }

  function retry() {
    if (!available || phase.step !== 'failed' || submitting.current) return
    if (phase.retry === 'catalog') return open()
    if (phase.retry === 'refresh') return refresh()
    return update({})
  }

  return { phase, draft, languages: catalog?.[draft.quality] ?? [], running, available, notice, open, update, confirm, close, retry }
}

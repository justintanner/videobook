import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { cleanupRegionsSchema, validateCleanupRegions, type CleanupMethod, type CleanupRegion } from '../../server/src/video-cleanup/model'
import type { ChatExecution } from './chat-turns'
import type { GraphicsTarget } from './graphics-model'

const readSchema = z.object({
  source: z.object({ width: z.number(), height: z.number(), duration_seconds: z.number(), fps: z.number(), source_hash: z.string() }),
  models: z.object({ detector: z.boolean(), lama: z.boolean(), download_bytes: z.number() }),
  interval: z.number(),
  detection: z.object({ status: z.string(), jobId: z.number().nullable(), error: z.string().nullable(), value: z.object({ regions: cleanupRegionsSchema, interval: z.number(), samples: z.number() }).nullable() }),
})
type CleanupRead = z.infer<typeof readSchema>
type Call = (tool: string, args: Record<string, unknown>, options?: { background?: boolean; chat?: ChatExecution }) => Promise<unknown>
type State = {
  target: GraphicsTarget | null
  bookId: string | null
  read: CleanupRead | null
  regions: CleanupRegion[]
  method: CleanupMethod
  busy: string | null
  jobId: number | null
  error: string | null
}
const EMPTY: State = { target: null, bookId: null, read: null, regions: [], method: 'lama', busy: null, jobId: null, error: null }
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 800))

export function useVideoCleanup({ bookId, ready, call }: { bookId: string | null; ready: boolean; call: Call }) {
  const [state, setState] = useState<State>(EMPTY)
  const current = useRef(EMPTY)
  const epoch = useRef(0)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  useEffect(() => () => { epoch.current++ }, [bookId, ready])

  const change = (update: (previous: State) => State) => {
    current.current = update(current.current)
    setState(current.current)
  }
  const args = (target: GraphicsTarget) => ({ book_id: bookId, asset_id: target.artifactId, notebook_id: target.notebookId ?? undefined })
  const active = (token: number) => epoch.current === token
  const fail = (token: number, error: unknown) => {
    if (active(token)) change((s) => ({ ...s, busy: null, jobId: null, error: error instanceof Error ? error.message : String(error) }))
  }

  const detectFor = async (target: GraphicsTarget, token: number, force: boolean) => {
    if (!ready || !bookId || !active(token)) return
    change((s) => ({ ...s, busy: 'Detecting text…', error: null }))
    try {
      let result = readSchema.parse(await call('remove_video_graphics', { ...args(target), op: 'detect', force }, { background: true }))
      const sourceHash = current.current.read?.source.source_hash
      while (active(token)) {
        if (sourceHash && result.source.source_hash !== sourceHash) throw new Error('The video changed. Close and reopen the remover.')
        change((s) => ({ ...s, read: result, jobId: result.detection.jobId }))
        if (!['queued', 'running'].includes(result.detection.status)) break
        await wait()
        if (!active(token)) return
        result = readSchema.parse(await call('remove_video_graphics', { ...args(target), op: 'get' }, { background: true }))
      }
      if (!active(token)) return
      if (result.detection.error) throw new Error(result.detection.error)
      if (!result.detection.value) throw new Error('Detection returned no result. Try again.')
      change((s) => ({ ...s, regions: result.detection.value!.regions, busy: null, jobId: null }))
    } catch (error) { fail(token, error) }
  }

  const open = (target: GraphicsTarget) => {
    const token = ++epoch.current
    request.current = null
    change(() => ({ ...EMPTY, target, bookId, busy: 'Loading video…' }))
    if (!ready || !bookId) { fail(token, new Error('Connect to Videobook first.')); return }
    void (async () => {
      try {
        const read = readSchema.parse(await call('remove_video_graphics', { ...args(target), op: 'get' }, { background: true }))
        if (!active(token)) return
        change((s) => ({ ...s, read, regions: read.detection.value?.regions ?? [], busy: null }))
        if (read.models.detector && !read.detection.value) await detectFor(target, token, false)
      } catch (error) { fail(token, error) }
    })()
  }

  const install = async () => {
    const target = current.current.target
    if (!target || !ready || !bookId || current.current.busy) return
    const token = ++epoch.current
    change((s) => ({ ...s, busy: 'Downloading local models…', error: null }))
    try {
      const job = z.object({ job_id: z.number() }).parse(await call('remove_video_graphics', { ...args(target), op: 'install_models' }, { background: true }))
      if (!active(token)) return
      change((s) => ({ ...s, jobId: job.job_id }))
      while (active(token)) {
        const result = z.object({ status: z.string(), error: z.string().nullable() }).parse(await call('remove_video_graphics', { ...args(target), op: 'status', job_id: job.job_id }, { background: true }))
        if (result.status === 'done') break
        if (['failed', 'aborted'].includes(result.status)) throw new Error(result.error ?? 'Model download stopped.')
        await wait()
      }
      if (active(token)) await detectFor(target, token, false)
    } catch (error) { fail(token, error) }
  }

  const render = async (chat?: ChatExecution) => {
    const { target, read, regions, method, busy } = current.current
    if (!ready || !bookId || current.current.bookId !== bookId || !target || !read || busy) return { ok: false, message: 'Wait for the video and regions to be ready.' }
    const token = epoch.current
    try {
      validateCleanupRegions(regions, read.source.duration_seconds)
      const fingerprint = JSON.stringify([target.artifactId, read.source.source_hash, method, regions])
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
      change((s) => ({ ...s, busy: 'Queuing removal…', error: null }))
      const result = z.object({ status: z.string(), job_id: z.number().nullable(), error: z.string().nullable() }).parse(await call('remove_video_graphics', {
        ...args(target), op: 'render', source_hash: read.source.source_hash, request_id: request.current.id, method, regions,
      }, { chat }))
      if (result.status === 'failed') throw new Error(result.error ?? 'Removal failed.')
      if (!active(token)) return { ok: false, message: 'The remover was closed.' }
      change((s) => ({ ...s, busy: null }))
      return { ok: true, message: `Local removal queued${result.job_id ? ` · job ${result.job_id}` : ''}. The cleaned copy will appear in the notebook.` }
    } catch (error) {
      fail(token, error)
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const cancel = async () => {
    const id = current.current.jobId
    if (!id || !ready || !bookId) return
    const token = ++epoch.current
    try {
      await call('cancel_job', { book_id: bookId, job_id: id }, { background: true })
      if (active(token)) change((s) => ({ ...s, busy: null, jobId: null }))
    } catch (error) { fail(token, error) }
  }

  return {
    state, open, install, render, cancel,
    close: () => { epoch.current++; change(() => EMPTY) },
    detect: () => { const target = current.current.target; if (target && !current.current.busy) void detectFor(target, ++epoch.current, true) },
    setRegions: (regions: CleanupRegion[]) => change((s) => ({ ...s, regions, error: null })),
    setMethod: (method: CleanupMethod) => change((s) => ({ ...s, method, error: null })),
  }
}

export type VideoCleanupEditor = ReturnType<typeof useVideoCleanup>

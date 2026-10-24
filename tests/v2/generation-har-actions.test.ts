import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prerenderToNodeStream } from 'react-dom/static'
import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import { GenerationHarActions } from '../../src/components/videobook/GenerationHarActions'
import { GeneratingRunColumns, type GeneratingRunFacts } from '../../src/components/videobook/GeneratingRunDetails'
import { NotebookCellInspector, type CellGenerationAttempt } from '../../src/components/videobook/NotebookCellInspector'
import { fetchGenerationHar } from '../../src/videobook/generation-har-download'
import {
  parseGenerationRequestInspection,
  type GenerationHarStatus,
} from '../../src/videobook/generation-request-inspection'

const captured: GenerationHarStatus = {
  mode: 'failures',
  hasCapture: true,
  captures: 2,
  path: '/home/me/.videobook/har/kie/api.v1.jobs.createTask/call.har',
  outcome: 'provider_error',
}
const off: GenerationHarStatus = { mode: 'off', hasCapture: false, captures: 0, path: null, outcome: null }
const uncaptured: GenerationHarStatus = { ...off, mode: 'all' }

const facts: GeneratingRunFacts = {
  runKind: 'failed',
  startedAt: null,
  provider: 'kie',
  model: 'kie:bytedance/seedance-2-5',
  runId: null,
  jobNumber: null,
  providerArtifactId: '01900000-0000-7000-8000-000000000021',
  writtenPrompt: 'A heron lands on the pier',
}

async function prerendered(element: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(element)
  let html = ''
  for await (const chunk of prelude) html += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  return html
}

function payloadColumns(har: GenerationHarStatus | null): ReactElement {
  return createElement(GeneratingRunColumns, {
    facts,
    header: null,
    inspect: async () => parseGenerationRequestInspection({
      payload: { model: 'bytedance/seedance-2-5', input: { prompt: 'A heron lands on the pier' } },
      error: { message: 'aspect_ratio is invalid' },
      har,
    }),
    onDownloadHar: async () => undefined,
    onOpenSettings: () => undefined,
  })
}

describe('generation HAR actions', () => {
  it('offers Download HAR in the Request payload panel when the attempt has a capture', async () => {
    const html = await prerendered(payloadColumns(captured))
    expect(html).toContain('Request payload')
    expect(html).toContain('aria-label="Download HAR"')
    expect(html).not.toContain('Capture off')
  })

  it('links Capture off to Settings when capture is off', async () => {
    const html = await prerendered(payloadColumns(off))
    expect(html).toContain('<a href="/settings"')
    expect(html).toContain('Capture off')
    expect(html).not.toContain('Download HAR')
  })

  it('shows neither when capture is on without a capture for the attempt', async () => {
    const html = await prerendered(payloadColumns(uncaptured))
    expect(html).toContain('Request payload')
    expect(html).not.toContain('Download HAR')
    expect(html).not.toContain('Capture off')
    expect(renderToStaticMarkup(createElement(GenerationHarActions, { generationId: 'a', status: null }))).toBe('')
    expect(renderToStaticMarkup(createElement(GenerationHarActions, {
      generationId: 'a', status: captured,
    }))).toBe('')
  })

  it('marks captured attempts in the generations panel and hints once that capture is off', () => {
    const cell: NotebookCell = {
      id: '01900000-0000-7000-8000-000000000031',
      type: 'generate_video',
      label: 'heron',
      slot: { row: 0, column: 0 },
      prompt: 'A heron lands on the pier',
    }
    const attempt = (attemptId: string, har: GenerationHarStatus): CellGenerationAttempt => ({
      attemptId, status: 'failed', runId: null, tool: 'generate_video', provider: 'kie', model: 'kie:bytedance/seedance-2-5',
      prompt: null, resolvedPrompt: null, artifactId: null, providerArtifactId: `${attemptId}-asset`, error: null,
      mediaUrl: null, thumbnailUrl: null, payloadAvailable: false, commandPlan: null, transitions: [], har,
      createdAt: 1, updatedAt: 1,
    })
    const render = (attempts: CellGenerationAttempt[]) => renderToStaticMarkup(createElement(NotebookCellInspector, {
      bookId: '01900000-0000-7000-8000-000000000032',
      notebookId: '01900000-0000-7000-8000-000000000033',
      cell,
      cells: [cell],
      edges: [],
      asset: undefined,
      status: 'failed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationsVisible: true,
      generations: { attempts, currentExecution: null, loading: false, error: null },
      onDownloadGenerationHar: async () => undefined,
      onOpenSettings: () => undefined,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    const withCapture = render([attempt('second', { ...captured, captures: 1 }), attempt('first', { ...uncaptured, mode: 'failures' })])
    expect(withCapture.match(/aria-label="Download HAR"/gu)).toHaveLength(1)
    expect(withCapture).not.toContain('Capture off')
    const captureOff = render([attempt('second', off), attempt('first', off)])
    expect(captureOff.match(/Capture off/gu)).toHaveLength(1)
    expect(captureOff).not.toContain('Download HAR')
  })

  it('fetches the attempt HAR through get_generation_har', async () => {
    const calls: unknown[] = []
    const har = { log: { version: '1.2', creator: { name: 'apicity', version: '0.18.0' }, entries: [] } }
    const file = await fetchGenerationHar(async (...args) => {
      calls.push(args)
      return { filename: 'videobook-generation-x.har', har }
    }, 'book-1', 'generation-1')
    expect(calls).toEqual([['get_generation_har', { book_id: 'book-1', generation_id: 'generation-1' }, { background: true }]])
    expect(file).toEqual({ filename: 'videobook-generation-x.har', text: `${JSON.stringify(har, null, 2)}\n` })
    await expect(fetchGenerationHar(async () => ({ filename: 'x.har' }), 'book-1', 'generation-1'))
      .rejects.toThrow('No HAR capture for this attempt')
  })
})

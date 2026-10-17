import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CostHints } from '@apicity/cost'
import { BookManager } from '../../server/src/book-manager.js'
import { estimateGeneration } from '../../server/src/media/cost.js'
import { tryResolveModel } from '../../server/src/media/descriptor.js'
import type { MediaRefs } from '../../server/src/media/types.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

interface Fixture { bookId: string; videoId: string; audioId: string; duration: number }
interface Estimate { usd: number; breakdown: Record<string, unknown>; warnings: string[] }
interface EstimateResult { estimate: Estimate; per_call: Array<{ tool_name: string; estimate: Estimate }> }
interface SourceCase { model: string; prompt?: string; source: 'video' | 'audio'; refs: MediaRefs; options: Record<string, unknown> }

const IMAGE_URL = 'https://example.test/still.png'
const VIDEO_URL = 'https://example.test/source.mp4'
const AUDIO_URL = 'https://example.test/voice.mp3'
const MOTION: SourceCase = { model: 'kie:kling-3.0/motion-control', source: 'video', refs: { image: [IMAGE_URL] }, options: {} }
const SOURCE_CASES: SourceCase[] = [
  MOTION,
  { model: 'kie:happyhorse/video-edit', prompt: 'make it rain', source: 'video', refs: {}, options: { resolution: '1080p' } },
  { model: 'kie:omnihuman-1-5', prompt: 'a calm presenter', source: 'audio', refs: { image: [IMAGE_URL] }, options: {} },
  { model: 'kie:volcengine/video-to-video-lip-sync', source: 'video', refs: { audio: [AUDIO_URL] }, options: { mode: 'lite' } },
]

function sourceRefs(item: SourceCase, ref: string): MediaRefs {
  return { ...item.refs, [item.source]: [ref] }
}

function expectedUsd(item: SourceCase, hints: CostHints): number {
  const model = tryResolveModel(item.model)
  if (!model) throw new Error(`Unknown model ${item.model}`)
  const placeholder = item.source === 'video' ? VIDEO_URL : AUDIO_URL
  const result = estimateGeneration(model, { prompt: item.prompt, refUrls: sourceRefs(item, placeholder), options: item.options }, hints)
  if (!result.ok) throw new Error(result.error)
  return result.estimate.usd
}

function sourceInput(item: SourceCase, fixture: Fixture, bookId: string = fixture.bookId): Record<string, unknown> {
  const ref = item.source === 'video' ? fixture.videoId : fixture.audioId
  return { book_id: bookId, model: item.model, ...(item.prompt ? { prompt: item.prompt } : {}), refs: sourceRefs(item, `@${ref}`), options: item.options }
}

describe('source-dependent cost endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let fixtures: Fixture[]

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-cost-context-http-'))
    const books = new BookManager({ libraryDir: join(rootDir, 'books') })
    fixtures = []
    try {
      await books.ready()
      for (const duration of [4, 9]) {
        const created = await books.create(`Cost ${duration}s`)
        if (!created.ok) throw new Error(created.error.message)
        const book = books.get(created.value.bookId)
        if (!book.ok) throw new Error(book.error.message)
        const engine = book.value.engine
        const video = await engine.artifacts.create({ kind: 'video', label: 'Video source' })
        const audio = await engine.artifacts.create({ kind: 'audio', label: 'Audio source' })
        if (!video.ok || !audio.ok) throw new Error('Could not create cost fixtures')
        for (const asset of [video.value, audio.value]) {
          const metadata = await engine.metadata.artifacts.write(asset.artifactId, 'original', { duration })
          if (!metadata.ok) throw new Error(metadata.error.message)
        }
        fixtures.push({ bookId: created.value.bookId, videoId: video.value.artifactId, audioId: audio.value.artifactId, duration })
      }
    } finally { await books.close() }
    server = await startServer(rootDir)
    client = new Client({ name: 'cost-context-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const estimate = (input: Record<string, unknown>) => callTool<EstimateResult>(client, 'estimate_cost', { calls: [{ tool_name: 'generate_video', input }] })

  it('resolves each source in its own book within a mixed batch', async () => {
    const calls = fixtures.map((fixture) => ({ tool_name: 'generate_video', input: sourceInput(MOTION, fixture) }))
    const actual = await callTool<EstimateResult>(client, 'estimate_cost', { calls })
    const expected = fixtures.map((fixture) => expectedUsd(MOTION, { inputDurationSeconds: fixture.duration }))
    expect(actual.per_call.map((call) => call.estimate.usd)).toEqual(expected)
    expect(new Set(expected).size).toBe(fixtures.length)
    expect(actual.estimate.usd).toBeCloseTo(expected.reduce((sum, usd) => sum + usd, 0), 8)
  })

  it.each(SOURCE_CASES)('reads the source duration for $model through book_id', async (item) => {
    for (const fixture of fixtures) {
      const actual = await estimate(sourceInput(item, fixture))
      expect(actual.estimate.warnings).toEqual([])
      expect(actual.estimate.usd).toBeGreaterThan(0)
      expect(actual.estimate.usd).toBeCloseTo(expectedUsd(item, { inputDurationSeconds: fixture.duration }), 8)
    }
  })

  it('does not enrich a foreign artifact through another book and rejects unknown books', async () => {
    const first = fixtures[0]!
    const second = fixtures[1]!
    const foreign = await estimate(sourceInput(MOTION, second, first.bookId))
    expect(foreign.estimate.usd).toBe(expectedUsd(MOTION, {}))
    expect(foreign.estimate.usd).not.toBe(expectedUsd(MOTION, { inputDurationSeconds: second.duration }))
    const unknown = await client.callTool({ name: 'estimate_cost', arguments: { calls: [{ tool_name: 'generate_video', input: sourceInput(MOTION, second, '00000000-0000-7000-8000-000000000001') }] } })
    expect(unknown.isError).toBe(true)
  })
})

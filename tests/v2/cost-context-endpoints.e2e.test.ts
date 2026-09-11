import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

interface Fixture { bookId: string; videoId: string; audioId: string; duration: number; resolution: string }
interface Estimate { usd: number; breakdown: Record<string, unknown>; warnings: string[] }
interface EstimateResult { estimate: Estimate; per_call: Array<{ tool_name: string; estimate: Estimate }> }

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
      for (const [duration, resolution] of [[4, '480p'], [9, '720p']] as const) {
        const created = await books.create(`Cost ${resolution}`)
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
        const payload = await engine.metadata.artifacts.write(video.value.artifactId, 'generation-payload', { model: 'grok-imagine/text-to-video', input: { resolution } })
        if (!payload.ok) throw new Error(payload.error.message)
        fixtures.push({ bookId: created.value.bookId, videoId: video.value.artifactId, audioId: audio.value.artifactId, duration, resolution })
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

  const estimate = (tool: string, input: Record<string, unknown>) => callTool<EstimateResult>(client, 'estimate_cost', { calls: [{ tool_name: tool, input }] })

  it('resolves each Grok extension source in its own book within a mixed batch', async () => {
    const calls = fixtures.map((fixture) => ({ tool_name: 'extend_kie_grok_imagine_video', input: { book_id: fixture.bookId, video_ref: `@${fixture.videoId}`, extend_times: '6' } }))
    const expected = await Promise.all(fixtures.map((fixture) => estimate('extend_kie_grok_imagine_video', { resolution: fixture.resolution, extend_times: '6' })))
    const actual = await callTool<EstimateResult>(client, 'estimate_cost', { calls })
    expect(actual.per_call.map((call) => call.estimate)).toEqual(expected.map((result) => result.estimate))
    expect(actual.estimate.usd).toBeCloseTo(expected.reduce((sum, result) => sum + result.estimate.usd, 0), 8)
  })

  it.each([
    ['generate_kie_kling_3_0_motion_control', 'motion_video_refs', { mode: '1080p' }],
    ['generate_kie_happyhorse_1_1_edit_video', 'video_ref', { resolution: '1080p' }],
    ['generate_kie_omnihuman_1_5_video', 'audio_ref', {}],
    ['generate_kie_volcengine_video_to_video_lip_sync', 'video_ref', {}],
  ] as const)('reads source duration for %s without a top-level book argument', async (tool, field, settings) => {
    for (const fixture of fixtures) {
      const ref = field === 'audio_ref' ? fixture.audioId : fixture.videoId
      const source = field === 'motion_video_refs' ? [`@${ref}`] : `@${ref}`
      const expected = await estimate(tool, { ...settings, duration: fixture.duration })
      const actual = await estimate(tool, { ...settings, book_id: fixture.bookId, [field]: source })
      expect(actual.estimate).toEqual(expected.estimate)
      expect(actual.estimate.usd).toBeGreaterThan(0)
    }
  })

  it('does not enrich a foreign artifact through another book and rejects unknown books', async () => {
    const first = fixtures[0]!
    const second = fixtures[1]!
    const expected = await estimate('extend_kie_grok_imagine_video', { extend_times: '6' })
    const foreign = await estimate('extend_kie_grok_imagine_video', { book_id: first.bookId, video_ref: second.videoId, extend_times: '6' })
    expect(foreign.estimate).toEqual(expected.estimate)
    const unknown = await client.callTool({ name: 'estimate_cost', arguments: { calls: [{ tool_name: 'extend_kie_grok_imagine_video', input: { book_id: '00000000-0000-7000-8000-000000000001', video_ref: second.videoId, extend_times: '6' } }] } })
    expect(unknown.isError).toBe(true)
  })
})

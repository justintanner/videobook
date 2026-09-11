import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { v7 as uuidv7 } from 'uuid'
import { MVP_CONTRACT_VERSION, type EditIntent, type Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

interface Asset { artifact_id: string; label: string; tags: { effective: Array<{ facet: string; key: string; label: string }> } }
interface Notebook { id: string; cells: Array<{ id: string; output_artifact_id?: string; slot: { row: number; column: number } }> }
interface Duplicate { new_asset_id: string; cell_id: string; address: string }

describe('asset lifecycle endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-asset-lifecycle-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'asset-lifecycle-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Lifecycle fixture' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const assets = async (args: Record<string, unknown> = {}) => (await call<{ assets: Asset[] }>('list_assets', args)).assets
  const sequence = () => call<Sequence>('get_primary_sequence')
  const notebook = (id: string) => call<Notebook>('get_notebook', { notebook_id: id })
  const idle = async () => {
    await expect.poll(async () => (await call<Array<{ state: string }>>('list_jobs')).every((job) => job.state === 'done'), { timeout: 60_000 }).toBe(true)
  }
  const upload = async () => {
    const data = await sharp({ create: { width: 64, height: 48, channels: 4, background: '#e0309080' } }).png().toBuffer()
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', { filename: 'fixture.png', data: data.toString('base64') })
    expect(uploaded.processingError).toBeUndefined()
    await idle()
    return uploaded.assetId
  }
  const file = async (id: string, name = 'original.png') => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${bookId}/${id}/${name}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const place = async (assetId: string) => {
    const created = await call<Notebook>('create_notebook', { name: 'Media' })
    await call('create_notebook_cell', { notebook_id: created.id, cell: {
      type: 'image', slot: { row: 0, column: 0 }, output_artifact_id: assetId,
    } })
    return notebook(created.id)
  }
  const addOverlay = async () => {
    const tracked = await call<Sequence>('add_sequence_track', { kind: 'video', name: 'Overlay' })
    const source = tracked.clips[0]!
    const intent: EditIntent = { intentVersion: MVP_CONTRACT_VERSION, commandId: uuidv7(), sequenceId: tracked.sequenceId,
      baseRevision: tracked.revision, actor: 'lifecycle-e2e', sourceSurface: 'ui', confirmationPolicy: 'reversible-single-step',
      operations: [{ kind: 'insert-clip', clipId: uuidv7(), mode: 'overwrite', placement: {
        trackId: tracked.tracks.filter((track) => track.kind === 'video').at(-1)!.trackId,
        timelineStartFrame: 15, durationFrames: 30, source: source.source,
      } }],
    }
    const preview = await call<{ valid: boolean; previewHash: string }>('preview_edit_intent', { intent })
    expect(preview.valid).toBe(true)
    await call('commit_edit_intent', { intent, preview_hash: preview.previewHash })
  }

  it('duplicates bytes and manual tags into a notebook cell, then edits the copy independently', async () => {
    const source = await upload()
    await call('add_asset_tag', { asset_id: source, facet: 'custom', label: '  Cat Study  ' })
    const original = await file(source)
    const graph = await place(source)
    const copy = await call<Duplicate>('duplicate_asset', { asset_id: source, notebook_id: graph.id })
    await idle()
    expect(copy.address).toBe('@b1')
    expect(await file(copy.new_asset_id)).toEqual(original)
    expect((await notebook(graph.id)).cells.find((cell) => cell.id === copy.cell_id)).toMatchObject({ output_artifact_id: copy.new_asset_id, slot: { row: 1, column: 0 } })
    expect((await assets({ tags_all: [{ facet: 'custom', label: 'cat study' }] })).map((asset) => asset.artifact_id).sort()).toEqual([source, copy.new_asset_id].sort())
    await call('remove_asset_tag', { asset_id: copy.new_asset_id, facet: 'custom', label: 'CAT STUDY' })
    expect((await assets({ tags_all: [{ facet: 'custom', label: 'cat study' }] })).map((asset) => asset.artifact_id)).toEqual([source])
    await call('invert_image', { asset_id: copy.new_asset_id })
    await idle()
    expect(await file(source)).toEqual(original)
    expect(await file(copy.new_asset_id)).not.toEqual(original)
  })

  it('rejects occupied and invalid duplicate destinations without creating assets', async () => {
    const source = await upload()
    const graph = await place(source)
    const before = await assets()
    for (const destination of ['@a1', '@bm1', '@a9']) {
      const rejected = await client.callTool({ name: 'duplicate_asset', arguments: { book_id: bookId, asset_id: source, notebook_id: graph.id, destination } })
      expect(rejected.isError, destination).toBe(true)
      expect(await assets()).toEqual(before)
      expect(await notebook(graph.id)).toEqual(graph)
    }
  })

  it('renames display labels while keeping media, notebook and timeline identities stable', async () => {
    const source = await upload()
    const graph = await place(source)
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: source }] })
    const before = await sequence()
    const bytes = await file(source)
    const renamed = await call<{ artifact_id: string; label: string }>('rename_asset', { asset_id: source, new_name: '猫 study / final ✨' })
    expect(renamed).toEqual({ artifact_id: source, label: '猫 study / final ✨' })
    expect((await sequence()).clips).toEqual(before.clips)
    expect((await notebook(graph.id)).cells).toEqual(graph.cells)
    expect(await file(source)).toEqual(bytes)
  })

  it('does not remove timeline clips when notebook references block deletion', async () => {
    const source = await upload()
    const graph = await place(source)
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: source }] })
    const before = await sequence()
    const bytes = await file(source)
    const rejected = await client.callTool({ name: 'delete_asset', arguments: { book_id: bookId, asset_id: source } })
    expect(rejected.isError).toBe(true)
    expect(await sequence()).toEqual(before)
    expect((await notebook(graph.id)).cells).toEqual(graph.cells)
    expect(await file(source)).toEqual(bytes)
  })

  it('deletes all primary-sequence references to an asset while preserving unrelated media', async () => {
    const source = await upload()
    const copy = await call<Duplicate>('duplicate_asset', { asset_id: source })
    await idle()
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: source }, { artifact_id: copy.new_asset_id }] })
    await addOverlay()
    const bytes = await file(copy.new_asset_id)
    const result = await call<{ status: string }>('delete_asset', { asset_id: source })
    expect(result.status).toBe('deleted')
    expect((await sequence()).clips.map((clip) => clip.source.artifactId)).toEqual([copy.new_asset_id])
    expect(await file(copy.new_asset_id)).toEqual(bytes)
    expect((await assets()).some((asset) => asset.artifact_id === source)).toBe(false)
  })

  it('forgets one duplicate while preserving bytes owned by the other', async () => {
    const source = await upload()
    const graph = await place(source)
    const copy = await call<Duplicate>('duplicate_asset', { asset_id: source })
    await idle()
    const bytes = await file(copy.new_asset_id)
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: source }] })
    const refused = await call<{ status: string }>('forget_asset', { asset_id: source })
    expect(refused.status).toBe('in_use')
    expect((await notebook(graph.id)).cells).toEqual(graph.cells)
    await addOverlay()
    const forgotten = await call<{ status: string; shared_objects: number; cleared_cells: number }>('forget_asset', { asset_id: source, clear_references: true })
    expect(forgotten.status).toBe('forgotten')
    expect(forgotten.shared_objects).toBeGreaterThan(0)
    expect(forgotten.cleared_cells).toBe(1)
    expect((await sequence()).clips).toEqual([])
    expect(await file(copy.new_asset_id)).toEqual(bytes)
  })

  it('keeps tag suggestions scoped to their book and counts normalized manual identities once', async () => {
    const source = await upload()
    for (const label of ['  Cat Study ', 'CAT STUDY', 'cat study']) await call('add_asset_tag', { asset_id: source, facet: 'custom', label })
    const result = await call<{ suggestions: Array<{ label: string; assets: number }>; tags: Asset['tags'] }>('suggest_asset_tags', { prefix: 'CAT', asset_id: source })
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]!.assets).toBe(1)
    expect(result.tags.effective).toHaveLength(1)
    const otherBook = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Other' })).bookId
    expect(await call('suggest_asset_tags', { book_id: otherBook })).toMatchObject({ suggestions: [] })
    const rejected = await client.callTool({ name: 'add_asset_tag', arguments: { book_id: otherBook, asset_id: source, label: 'Foreign' } })
    expect(rejected.isError).toBe(true)
    expect((await assets()).find((asset) => asset.artifact_id === source)?.tags.effective).toHaveLength(1)
  })
})

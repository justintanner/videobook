import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

interface Cell { id: string; type: string; slot: { row: number; column: number }; prompt?: string; label?: string }
interface Edge { id: string; source: string; target: string; target_input: string }
interface Notebook { id: string; revision: string; cells: Cell[]; edges: Edge[] }

describe('notebook graph endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let notebookId: string
  let first: Cell
  let second: Cell
  let generated: Cell

  const connect = async () => {
    server = await startServer(rootDir)
    client = new Client({ name: 'notebook-graph-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  }
  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, notebook_id: notebookId, ...args })
  const graph = () => call<Notebook>('get_notebook')
  const create = (type: string, row: number, column: number, prompt: string) => call<Cell>('create_notebook_cell', { cell: { type, slot: { row, column }, prompt } })
  const setInput = (source: string | null, extra: Record<string, unknown> = {}) => call('set_notebook_cell_input', { target_cell_id: generated.id, target_input: 'prompt', source_cell_id: source, ...extra })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-graph-http-'))
    await connect()
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Graph fixtures' })).bookId
    notebookId = (await callTool<Notebook[]>(client, 'list_notebooks', { book_id: bookId }))[0]!.id
    first = await create('prompt', 0, 0, 'Blue yarn')
    second = await create('prompt', 1, 0, 'Ginger cat')
    generated = await create('generate_image', 0, 1, 'Cat picture')
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it.each([{ row: 26, column: 0 }, { row: 51, column: 7 }, { row: 63, column: 7 }])('moves connected cells to the full grid at $row,$column and preserves them after restart', async (slot) => {
    const edge = await call<Edge>('connect_notebook_cells', { source_cell_id: first.id, target_cell_id: generated.id, target_input: 'prompt' })
    await call('move_notebook_cells', { slots: [{ id: first.id, ...slot }], expected_revision: (await graph()).revision })
    expect((await graph()).cells.find((cell) => cell.id === first.id)?.slot).toEqual(slot)
    expect((await graph()).edges.map((item) => item.id)).toContain(edge.id)
    await client.close()
    await stopServer(server)
    await connect()
    const reopened = await graph()
    expect(reopened.cells.find((cell) => cell.id === first.id)?.slot).toEqual(slot)
    expect(reopened.edges.map((item) => item.id)).toContain(edge.id)
  })

  it('swaps occupied cells and moves groups without changing identities or connections', async () => {
    await setInput(first.id)
    const before = await graph()
    await call('move_notebook_cells', { slots: [{ id: first.id, ...second.slot }] })
    const swapped = await graph()
    expect(swapped.cells.find((cell) => cell.id === first.id)?.slot).toEqual(second.slot)
    expect(swapped.cells.find((cell) => cell.id === second.id)?.slot).toEqual(first.slot)
    expect(swapped.edges).toEqual(before.edges)
    await call('move_notebook_cells', { slots: [{ id: first.id, row: 3, column: 2 }, { id: second.id, row: 3, column: 3 }] })
    expect((await graph()).edges).toEqual(before.edges)
  })

  it('pins a real image search result at the final notebook grid square', async () => {
    const data = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'blue' } }).png().toBuffer()
    const uploaded = await call<{ assetId: string }>('upload_file', { filename: 'blue.png', data: data.toString('base64') })
    const hit = {
      artifactId: uploaded.assetId, artifactKind: 'image', artifactLabel: 'Blue image', score: 1,
      location: { kind: 'still', artifactId: uploaded.assetId, sourcePath: 'original.png', objectHash: createHash('sha256').update(data).digest('hex') },
      signals: [{ kind: 'metadata', rank: 1, score: 1 }], indexManifestIds: [],
    }
    await call('pin_search_moment', { slot: { row: 63, column: 7 }, query: { text: 'blue' }, hit })
    expect((await graph()).cells.find((cell) => cell.slot.row === 63 && cell.slot.column === 7)?.type).toBe('image')
    const before = await graph()
    const result = await client.callTool({ name: 'pin_search_moment', arguments: { book_id: bookId, notebook_id: notebookId, slot: { row: 0, column: 8 }, query: { text: 'blue' }, hit } })
    expect(result.isError).toBe(true)
    expect(await graph()).toEqual(before)
  })

  it('rejects invalid, duplicated and colliding group moves without changing the graph', async () => {
    const before = await graph()
    for (const slots of [
      [{ id: first.id, row: 64, column: 0 }], [{ id: first.id, row: 0, column: 8 }],
      [{ id: first.id, row: -1, column: 0 }], [{ id: first.id, row: 0.5, column: 0 }],
      [{ id: first.id, row: 2, column: 0 }, { id: first.id, row: 3, column: 0 }],
      [{ id: first.id, row: 2, column: 0 }, { id: second.id, row: 2, column: 0 }],
      [{ id: first.id, row: 0, column: 1 }, { id: second.id, row: 2, column: 0 }],
      [{ id: '00000000-0000-7000-8000-000000000001', row: 2, column: 0 }],
    ]) {
      const result = await client.callTool({ name: 'move_notebook_cells', arguments: { book_id: bookId, notebook_id: notebookId, slots } })
      expect(result.isError).toBe(true)
      expect(await graph()).toEqual(before)
    }
  })

  it('rejects cycles while replacing or clearing an input and disconnects only the requested edge', async () => {
    await setInput(first.id)
    await setInput(second.id)
    let current = await graph()
    expect(current.edges).toHaveLength(1)
    expect(current.edges[0]!.source).toBe(second.id)
    const before = current
    for (const name of ['connect_notebook_cells', 'set_notebook_cell_input']) {
      const result = await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, source_cell_id: generated.id, target_cell_id: second.id, target_input: 'input' } })
      expect(result.isError).toBe(true)
      expect(await graph()).toEqual(before)
    }
    await call('disconnect_notebook_cells', { edge_id: current.edges[0]!.id })
    expect((await graph()).edges).toEqual([])
    await setInput(first.id)
    await setInput(null)
    current = await graph()
    expect(current.edges).toEqual([])
    expect(current.cells.map((cell) => cell.id)).toEqual(before.cells.map((cell) => cell.id))
  })

  it.each(['update_notebook_cell', 'set_notebook_cell_input', 'delete_notebook_cell'] as const)('allows only one concurrent %s at the same revision', async (name) => {
    const expected_revision = (await graph()).revision
    const results = await Promise.allSettled([first, second].map((cell, index) => call(name, {
      expected_revision,
      ...(name === 'update_notebook_cell' ? { cell_id: cell.id, cell: { label: `changed ${index}` } } : {}),
      ...(name === 'delete_notebook_cell' ? { cell_id: cell.id } : {}),
      ...(name === 'set_notebook_cell_input' ? { target_cell_id: generated.id, target_input: 'prompt', source_cell_id: cell.id } : {}),
    })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('preserves concurrently added cells when relayout runs', async () => {
    await call('move_notebook_cells', { slots: [{ id: first.id, row: 10, column: 6 }, { id: second.id, row: 20, column: 6 }, { id: generated.id, row: 15, column: 6 }] })
    const results = await Promise.all([
      call('relayout_notebook'),
      ...Array.from({ length: 6 }, (_, column) => create('prompt', 62, column, `Concurrent prompt ${column}`)),
    ])
    const created = results.slice(1) as Cell[]
    const current = await graph()
    expect(current.cells).toHaveLength(9)
    expect(current.cells.map((cell) => cell.id)).toEqual(expect.arrayContaining([...created.map((cell) => cell.id), first.id, second.id, generated.id]))
  })
})

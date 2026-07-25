import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface StartedServer {
  child: ChildProcessWithoutNullStreams
  output: string[]
  url: string
}

interface BookPayload {
  bookId: string
  slug: string
}

interface NotebookPayload {
  id: string
  name: string
}

interface CellPayload {
  id: string
}

interface NotebookDocumentPayload {
  cells: Array<{ id: string; title: string }>
  edges: Array<{ id: string; source: string; target: string; targetInput: string }>
}

interface AssetPayload {
  id: string
  artifact_id: string
  type: string
}

interface HistoryPayload {
  actions: Array<{ operation: string; phase: string; events: Array<{ phase: string }> }>
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve an HTTP port')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

async function startServer(rootDir: string): Promise<StartedServer> {
  const port = await availablePort()
  const output: string[] = []
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        B2_ACCESS_KEY_ID: '',
        B2_BUCKET: '',
        B2_ENDPOINT: '',
        B2_REGION: '',
        B2_SECRET_ACCESS_KEY: '',
        PORT: String(port),
        VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime', 'app-state.json'),
        VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (data: Buffer) => output.push(data.toString()))
  child.stderr.on('data', (data: Buffer) => output.push(data.toString()))
  const started = { child, output, url: `http://127.0.0.1:${port}/mcp` }

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited during startup:\n${output.join('')}`)
    }
    try {
      const response = await fetch(started.url)
      if (response.status === 405) return started
    } catch {
      await wait(100)
    }
  }
  throw new Error(`MCP server did not start:\n${output.join('')}`)
}

async function stopServer(server: StartedServer | undefined): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => server.child.once('exit', () => resolve()))
  server.child.kill('SIGINT')
  const stopped = await Promise.race([
    exited.then(() => true),
    wait(5_000).then(() => false),
  ])
  if (stopped) return
  server.child.kill('SIGKILL')
  await exited
}

async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    const message = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
    throw new Error(`${name} failed: ${message}`)
  }
  const content = result.content.find((item) => item.type === 'text')
  if (!content || content.type !== 'text') {
    throw new Error(`${name} did not return text content`)
  }
  return JSON.parse(content.text) as T
}

describe('v2 MCP server', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client | undefined

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-v2-e2e-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'videobook-v2-e2e', version: '1.0.0' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('serves multi-book notebooks, uploads, typed timelines, and durable history', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')

    const book = await callTool<BookPayload>(client, 'create_book', { slug: 'mcp-story' })
    expect(book).toMatchObject({ slug: 'mcp-story', bookId: expect.any(String) })

    const notebooks = await callTool<NotebookPayload[]>(client, 'list_notebooks', {
      book_id: book.bookId,
    })
    expect(notebooks).toEqual([{
      id: expect.any(String),
      name: 'Main',
      created_at: expect.any(String),
      properties: {},
      cells: [],
      edges: [],
    }])
    const notebook = notebooks[0]!

    const prompt = await callTool<CellPayload>(client, 'create_notebook_cell', {
      book_id: book.bookId,
      notebook_id: notebook.id,
      cell: {
        type: 'prompt',
        title: 'Opening prompt',
        slot: { row: 0, column: 0 },
        prompt: 'A green city at sunrise',
      },
    })
    const image = await callTool<CellPayload>(client, 'create_notebook_cell', {
      book_id: book.bookId,
      notebook_id: notebook.id,
      cell: {
        type: 'image',
        title: 'Opening image',
        slot: { row: 0, column: 1 },
        prompt: 'A green city at sunrise',
        model: 'generate_kie_gpt_image_2_text_to_image',
      },
    })
    await callTool(client, 'connect_notebook_cells', {
      book_id: book.bookId,
      notebook_id: notebook.id,
      source_cell_id: prompt.id,
      target_cell_id: image.id,
      target_input: 'prompt',
    })

    const document = await callTool<NotebookDocumentPayload>(client, 'get_notebook', {
      book_id: book.bookId,
      notebook_id: notebook.id,
    })
    expect(document.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: prompt.id, title: 'Opening prompt' }),
      expect.objectContaining({ id: image.id, title: 'Opening image' }),
    ]))
    expect(document.edges).toEqual([
      expect.objectContaining({ source: prompt.id, target: image.id, targetInput: 'prompt' }),
    ])

    const uploaded = await fetch(`${server.url.replace('/mcp', '')}/api/books/${book.bookId}/upload?filename=notes.md`, {
      method: 'POST',
      body: '# Green city notes',
    })
    expect(uploaded.ok).toBe(true)
    const upload = await uploaded.json() as { assetId: string }
    expect(upload.assetId).toMatch(/^script-/)

    const assets = await callTool<{ assets: AssetPayload[] }>(client, 'list_assets', {
      book_id: book.bookId,
    })
    const script = assets.assets.find((asset) => asset.id === upload.assetId)
    expect(script).toMatchObject({ artifact_id: expect.any(String), type: 'script' })
    if (!script) throw new Error('Uploaded script was not listed')

    const timeline = await callTool<{ slots: Array<{ artifact_id: string; id: string }> }>(client, 'set_timeline', {
      book_id: book.bookId,
      render: 'square',
      slots: [{ artifact_id: script.artifact_id }],
    })
    expect(timeline.slots).toEqual([{ artifact_id: script.artifact_id, id: expect.any(String) }])

    const history = await callTool<HistoryPayload>(client, 'list_book_actions', {
      book_id: book.bookId,
    })
    const creation = history.actions.find((action) => action.operation === 'tool-create-notebook-cell')
    expect(creation).toMatchObject({ phase: 'completed' })
    expect(creation?.events.map((event) => event.phase)).toEqual(['requested', 'completed'])
    expect(server.output.join('')).not.toContain('[mcp] history record failed')

    const deleted = await callTool<{ bookId: string; slug: string }>(client, 'delete_book', {
      book_id: book.bookId,
      confirm_slug: 'mcp-story',
    })
    expect(deleted).toEqual({ bookId: book.bookId, slug: 'mcp-story' })
  })
})

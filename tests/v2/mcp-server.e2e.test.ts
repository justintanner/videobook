import { execFile, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG } from '../../server/src/ffmpeg.js'

const execFileAsync = promisify(execFile)

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
  cells: Array<{ id: string; slug: string }>
  edges: Array<{ id: string; source: string; target: string; targetInput: string }>
}

interface AssetPayload {
  id: string
  artifact_id: string
  type: string
}

interface HistoryPayload {
  actions: Array<{
    operation: string
    details: { writeSet?: string[] }
  }>
}

interface ChatModelsPayload {
  defaultModel: string
  models: Array<{ id: string; label: string; description: string }>
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
    client = new Client(
      { name: 'videobook-v2-e2e', version: '1.0.0' },
      {
        capabilities: {},
        supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('serves only MCP 2026-07-28 with stateless cache metadata', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')

    expect(client.getProtocolEra()).toBe('modern')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect(client.getDiscoverResult()).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: true } },
    })
    expect(client.getServerVersion()).toEqual({ name: 'videobook', version: '0.1.0' })

    const tools = await client.listTools()
    expect(tools.ttlMs).toBe(0)
    expect(tools.cacheScope).toBe('private')
    expect(tools.tools.length).toBeGreaterThan(0)

    const legacy = await fetch(server.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
    expect(legacy.status).toBe(400)
    expect(legacy.headers.get('mcp-session-id')).toBeNull()
    expect(await legacy.json()).toMatchObject({
      error: {
        code: -32022,
        data: { supported: ['2026-07-28'] },
      },
      id: 1,
    })

    const missingHeaders = await fetch(server.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'list_books',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': {
              name: 'videobook-header-check',
              version: '1.0.0',
            },
          },
        },
      }),
    })
    expect(missingHeaders.status).toBe(400)
    expect(await missingHeaders.json()).toMatchObject({
      error: { code: -32020 },
      id: 2,
    })
  })

  it('serves multi-book notebooks, uploads, typed timelines, and durable history', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')

    const chatModels = await callTool<ChatModelsPayload>(client, 'list_chat_models', {})
    expect(chatModels).toEqual({
      defaultModel: 'gpt-5.6-sol',
      models: [
        expect.objectContaining({ id: 'gpt-5.6-sol', label: 'Sol' }),
        expect.objectContaining({ id: 'gpt-5.6-terra', label: 'Terra' }),
      ],
    })

    const book = await callTool<BookPayload>(client, 'create_book', { slug: 'mcp-story' })
    expect(book).toMatchObject({ slug: 'mcp-story', bookId: expect.any(String) })

    const notebooks = await callTool<NotebookPayload[]>(client, 'list_notebooks', {
      book_id: book.bookId,
    })
    expect(notebooks).toEqual([expect.objectContaining({
      id: expect.any(String),
      name: 'Main',
      created_at: expect.any(String),
      cells: [],
      edges: [],
    })])
    const notebook = notebooks[0]!

    const prompt = await callTool<CellPayload>(client, 'create_notebook_cell', {
      book_id: book.bookId,
      notebook_id: notebook.id,
      cell: {
        type: 'prompt',
        slug: 'prompt-opening',
        slot: { row: 0, column: 0 },
        prompt: 'A green city at sunrise',
      },
    })
    const image = await callTool<CellPayload>(client, 'create_notebook_cell', {
      book_id: book.bookId,
      notebook_id: notebook.id,
      cell: {
        type: 'generate_image',
        slug: 'generate-image-opening',
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
      expect.objectContaining({ id: prompt.id, slug: 'prompt-opening' }),
      expect.objectContaining({ id: image.id, slug: 'generate-image-opening' }),
    ]))
    expect(document.edges).toEqual([
      expect.objectContaining({ source: prompt.id, target: image.id, targetInput: 'prompt' }),
    ])

    const videoPath = join(rootDir, 'timeline-source.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=0x163d2b:s=320x240:r=24:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      videoPath,
    ])
    const videoBytes = await readFile(videoPath)
    const videoBody = videoBytes.buffer.slice(
      videoBytes.byteOffset,
      videoBytes.byteOffset + videoBytes.byteLength,
    ) as ArrayBuffer
    const uploaded = await fetch(`${server.url.replace('/mcp', '')}/api/books/${book.bookId}/upload?filename=timeline-source.mp4`, {
      method: 'POST',
      body: videoBody,
    })
    expect(uploaded.ok).toBe(true)
    const upload = await uploaded.json() as { assetId: string }
    expect(upload.assetId).toMatch(/^vid-/)

    const assets = await callTool<{ assets: AssetPayload[] }>(client, 'list_assets', {
      book_id: book.bookId,
    })
    const video = assets.assets.find((asset) => asset.id === upload.assetId)
    expect(video).toMatchObject({ artifact_id: expect.any(String), type: 'video' })
    if (!video) throw new Error('Uploaded video was not listed')

    const timeline = await callTool<{ slots: Array<{ artifact_id: string; id: string }> }>(client, 'set_timeline', {
      book_id: book.bookId,
      render: 'square',
      slots: [{ artifact_id: video.artifact_id }],
    })
    expect(timeline.slots).toEqual([{ artifact_id: video.artifact_id, id: expect.any(String) }])

    const history = await callTool<HistoryPayload>(client, 'list_book_actions', {
      book_id: book.bookId,
    })
    const notebookWrites = history.actions
      .filter((action) => action.operation === 'write_notebook')
      .flatMap((action) => action.details.writeSet ?? [])
    expect(notebookWrites).toEqual(expect.arrayContaining([
      `cell:${notebook.id}:${prompt.id}`,
      `cell:${notebook.id}:${image.id}`,
    ]))
    expect(server.output.join('')).not.toContain('[mcp] history record failed')

    const deleted = await callTool<{ bookId: string; slug: string }>(client, 'delete_book', {
      book_id: book.bookId,
      confirm_slug: 'mcp-story',
    })
    expect(deleted).toEqual({ bookId: book.bookId, slug: 'mcp-story' })
  })
})

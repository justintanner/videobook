import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager'
import { MCP_PROTOCOL_VERSION } from '../../server/src/server'
import { getCanonicalCommands } from '../../server/src/tools/commands'
import { applyInjectedCommandArgs, parseSlashCommandArgs } from '../../src/lib/command-registry'
import { performBrowserFileAction, performMediaFileAction } from '../../src/videobook/use-media-file-actions'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server'

describe('browser media downloads', () => {
  let root: string
  let downloads: string
  let previousDownloads: string | undefined
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let artifactId: string
  const bytes = 'original fixture bytes'
  const saved: Array<{ url: string, filename: string }> = []
  const browser = (hostname: string) => ({ hostname, save: (url: string, filename: string) => { saved.push({ url, filename }) } })
  const call = (tool: string, args: Record<string, unknown>) => callTool<unknown>(client, tool, args)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'browser-media-download-'))
    downloads = join(root, 'downloads')
    await mkdir(downloads)
    previousDownloads = process.env.VIDEOBOOK_DOWNLOADS_DIR
    process.env.VIDEOBOOK_DOWNLOADS_DIR = downloads
    const books = new BookManager({ libraryDir: join(root, 'books') })
    try {
      await books.ready()
      const created = await books.create('Download fixture')
      if (!created.ok) throw new Error(created.error.message)
      bookId = created.value.bookId
      const book = books.get(bookId)
      if (!book.ok) throw new Error(book.error.message)
      const artifact = await book.value.engine.artifacts.create('video', 'take / original')
      if (!artifact.ok) throw new Error(artifact.error.message)
      artifactId = artifact.value.artifactId
      for (const [name, value] of Object.entries({ 'original.mp4': bytes, 'proxy.mp4': 'proxy', 'thumbnail.jpg': 'thumbnail' })) {
        const written = await book.value.engine.files.write(artifactId, name, value)
        if (!written.ok) throw new Error(written.error.message)
      }
    } finally {
      await books.close()
    }
    server = await startServer(root)
    client = new Client({ name: 'browser-download-test', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: [MCP_PROTOCOL_VERSION], versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  })

  beforeEach(async () => {
    saved.length = 0
    for (const filename of await readdir(downloads)) await rm(join(downloads, filename))
  })

  afterAll(async () => {
    await client?.close()
    await stopServer(server)
    if (previousDownloads === undefined) delete process.env.VIDEOBOOK_DOWNLOADS_DIR
    else process.env.VIDEOBOOK_DOWNLOADS_DIR = previousDownloads
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  async function expectAttachment() {
    expect(saved).toHaveLength(1)
    expect(saved[0]!.filename).toBe('download-fixture.mp4')
    const response = await fetch(new URL(saved[0]!.url, server!.url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="download-fixture.mp4"')
    expect(await response.text()).toBe(bytes)
    expect(await readdir(downloads)).toEqual([])
  }

  it.each(['vb.superlzy.com', '192.168.1.20', 'localhost.example'])('downloads the original in the browser on %s without a server copy', async (hostname) => {
    expect(await performMediaFileAction(call, 'download', bookId, artifactId, browser(hostname))).toBe('Downloading download-fixture.mp4')
    await expectAttachment()
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('keeps copying on loopback page %s with collision-safe names', async (hostname) => {
    for (const suffix of ['', ' (2)']) {
      const path = join(downloads, `download-fixture${suffix}.mp4`)
      expect(await performMediaFileAction(call, 'download', bookId, artifactId, browser(hostname))).toBe(`Saved ${path}`)
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }
    expect(saved).toEqual([])
  })

  it('routes a parsed UI slash command and workspace download to the browser', async () => {
    const command = getCanonicalCommands().find(entry => entry.command === '/download')!
    const args = { ...applyInjectedCommandArgs(command, parseSlashCommandArgs(command, artifactId)), book_id: bookId }
    expect(await performBrowserFileAction(call, command.mcpTool!.tool, args, browser('vb.superlzy.com'))).toBe('Downloading download-fixture.mp4')
    await expectAttachment()
    saved.length = 0
    expect(await performBrowserFileAction(call, 'export_asset_file', { book_id: bookId, asset_id: artifactId, to: 'downloads' }, browser('vb.superlzy.com'))).toBe('Downloading download-fixture.mp4')
    await expectAttachment()
  })

  it('leaves local slash commands and browserless MCP downloads on the copy path', async () => {
    const args = { book_id: bookId, asset_id: artifactId, to: 'downloads' }
    expect(await performBrowserFileAction(call, 'export_asset_file', args, browser('localhost'))).toBeNull()
    expect(await call('export_asset_file', args)).toEqual({ status: 'exported', path: join(downloads, 'download-fixture.mp4') })
    expect(await readFile(join(downloads, 'download-fixture.mp4'), 'utf8')).toBe(bytes)
    expect(saved).toEqual([])
  })

  it('does not reroute clipboard actions or start a download for missing originals', async () => {
    expect(await performBrowserFileAction(call, 'export_asset_file', { book_id: bookId, asset_id: artifactId, to: 'clipboard' }, browser('vb.superlzy.com'))).toBeNull()
    await expect(performMediaFileAction(call, 'download', bookId, 'missing', browser('vb.superlzy.com'))).rejects.toThrow()
    expect(saved).toEqual([])
    expect(await readdir(downloads)).toEqual([])
  })
})

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { chromium } from 'playwright'
import { EXTENSION_ORIGIN } from '../../server/src/http-access.js'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isUuidV7 } from 'videobook-engine'
import { FFMPEG } from '../../server/src/ffmpeg.js'

const execFileAsync = promisify(execFile)

interface StartedServer {
  child: ChildProcess
  output: string[]
  url: string
}

interface BookPayload {
  bookId: string
  name: string
}

interface NotebookPayload {
  id: string
  name: string
}

interface CellPayload {
  id: string
  output_cell?: {
    id: string
    type: string
  }
}

interface NotebookDocumentPayload {
  cells: Array<{ id: string; label?: string; address: string }>
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
        VIDEOBOOK_ARCHIVE_DIR: join(rootDir, 'archive'),
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

  it('rejects foreign origins and rebinding hosts across all HTTP routes before parsing or mutation', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')
    const base = server.url.replace('/mcp', '')
    const book = await callTool<BookPayload>(client, 'create_book', { name: 'PRIVATE_HTTP_FIXTURE' })
    const paths = [
      ['GET', '/healthz'], ['POST', '/mcp'], ['OPTIONS', '/mcp'],
      ['GET', `/files/${book.bookId}/missing/original.png`],
      ['GET', `/api/books/${book.bookId}/artifacts/missing/manifest`],
      ['POST', `/api/books/${book.bookId}/upload?filename=attack.png`],
      ['POST', `/api/search-references?bookId=${book.bookId}&kind=image&filename=attack.png`],
      ['DELETE', '/api/search-references/missing'], ['GET', '/archive-files/private.txt'],
    ]
    await mkdir(join(rootDir, 'archive'), { recursive: true })
    await writeFile(join(rootDir, 'archive/private.txt'), 'PRIVATE_ARCHIVE_BYTES')
    const before = await callTool<unknown>(client, 'list_assets', { book_id: book.bookId })
    for (const headers of [
      { origin: 'https://untrusted.example' }, { origin: 'null' },
      { host: 'untrusted.example' }, { 'sec-fetch-site': 'cross-site' },
      { host: 'untrusted.example', 'x-forwarded-host': 'localhost', origin: base },
    ]) {
      for (const [method, path] of paths) {
        const response = await new Promise<{ status: number; body: string; allowOrigin: string | string[] | undefined }>((resolve, reject) => {
          const request = httpRequest(`${base}${path}`, { method, headers: { ...headers, 'content-type': 'application/json' } }, (response) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (part: string) => { body += part })
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body, allowOrigin: response.headers['access-control-allow-origin'] }))
          })
          request.on('error', reject)
          request.end(method === 'POST' ? '{invalid-json' : undefined)
        })
        expect(response.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403)
        expect(response.allowOrigin).toBeUndefined()
        expect(response.body).not.toContain('PRIVATE_')
      }
    }
    expect(await callTool<unknown>(client, 'list_assets', { book_id: book.bookId })).toEqual(before)
    expect(await (await fetch(`${base}/archive-files/private.txt`)).text()).toBe('PRIVATE_ARCHIVE_BYTES')
    const preflight = await fetch(server.url, { method: 'OPTIONS', headers: {
      origin: 'http://localhost:5173', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(preflight.headers.get('vary')).toContain('Origin')
  })

  it('enforces owning-book artifact references for actual file, range, and manifest requests', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')
    const base = server.url.replace('/mcp', '')
    const owner = await callTool<BookPayload>(client, 'create_book', { name: 'HTTP owner' })
    const foreign = await callTool<BookPayload>(client, 'create_book', { name: 'HTTP foreign' })
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC', 'base64')
    const upload = await fetch(`${base}/api/books/${owner.bookId}/upload?filename=private.png`, { method: 'POST', body: bytes })
    expect(upload.status).toBe(200)
    const asset = await upload.json() as { assetId: string }
    const manifestPath = `/api/books/${owner.bookId}/artifacts/${asset.assetId}/manifest`
    const manifest = await (await fetch(`${base}${manifestPath}`)).json() as { files: Array<{ name: string; objectHash: string }> }
    const primary = manifest.files.find((file) => file.name === 'original.png')!
    expect(primary).toBeDefined()
    const filePath = `/files/${owner.bookId}/${asset.assetId}/${primary.name}`
    expect(Buffer.from(await (await fetch(`${base}${filePath}`)).arrayBuffer())).toEqual(bytes)
    const partial = await fetch(`${base}${filePath}`, { headers: { range: 'bytes=1-4' } })
    expect(partial.status).toBe(206)
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(1, 5))
    for (const path of [
      filePath.replace(owner.bookId, foreign.bookId), manifestPath.replace(owner.bookId, foreign.bookId),
      filePath.replace(asset.assetId, primary.objectHash), manifestPath.replace(asset.assetId, primary.objectHash),
      `/files/${foreign.bookId}/${asset.assetId}/%2e%2e%2f${primary.name}`,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { range: 'bytes=0-9' } })
      expect([400, 404]).toContain(response.status)
      expect(await response.text()).not.toContain(bytes.toString('base64'))
    }
    for (const path of [filePath, manifestPath]) {
      expect((await fetch(`${base}${path}`, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    }
  })

  it('keeps media validators consistent for conditional downloads, ranges, and HEAD', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')
    const base = server.url.replace('/mcp', '')
    const book = await callTool<BookPayload>(client, 'create_book', { name: 'HTTP range validation' })
    const bytes = Buffer.from('# HTTP range fixture\nA stable document for download validation.\n')
    const upload = await fetch(`${base}/api/books/${book.bookId}/upload?filename=ranges.md`, { method: 'POST', body: bytes })
    expect(upload.status).toBe(200)
    const asset = await upload.json() as { assetId: string }
    const url = `${base}/files/${book.bookId}/${asset.assetId}/original.md`
    const requestFile = (method: string, headers: Record<string, string> = {}) => new Promise<{
      status: number
      body: Buffer
      etag: string | undefined
      length: string | undefined
      range: string | undefined
    }>((resolve, reject) => {
      const request = httpRequest(url, { method, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
          etag: response.headers.etag,
          length: response.headers['content-length'],
          range: response.headers['content-range'],
        }))
      })
      request.on('error', reject)
      request.end()
    })
    const full = await requestFile('GET')
    expect(full.status).toBe(200)
    expect(full.body).toEqual(bytes)
    expect(full.etag).toMatch(/^"[^"]+"$/u)
    const etag = full.etag!
    for (const range of ['bytes=0-9', 'bytes=-10']) {
      const partial = await requestFile('GET', { range, 'if-range': etag })
      expect(partial.status).toBe(206)
      expect(partial.etag).toBe(etag)
      expect(partial.body).toEqual(range === 'bytes=0-9' ? bytes.subarray(0, 10) : bytes.subarray(-10))
    }
    for (const range of ['bytes=0-9', 'bytes=99999-']) {
      const head = await requestFile('HEAD', { range })
      expect(head).toMatchObject({ status: 200, etag, length: String(bytes.length), range: undefined })
      expect(head.body.length).toBe(0)
      for (const validator of [etag, `W/${etag}`, '*']) {
        const cached = await requestFile('GET', { range, 'if-none-match': validator })
        expect(cached).toMatchObject({ status: 304, etag, range: undefined })
        expect(cached.body.length).toBe(0)
      }
    }
    for (const validator of ['"outdated-file"', `W/${etag}`, 'Wed, 01 Jan 2020 00:00:00 GMT']) {
      const stale = await requestFile('GET', { range: 'bytes=0-9', 'if-range': validator })
      expect(stale).toMatchObject({ status: 200, etag, range: undefined })
      expect(stale.body).toEqual(bytes)
    }
    const unsatisfied = await requestFile('GET', { range: 'bytes=99999-', 'if-range': etag })
    expect(unsatisfied).toMatchObject({ status: 416, range: `bytes */${bytes.length}` })
    const refreshed = await requestFile('GET', { range: 'bytes=0-9', 'if-none-match': '"outdated-file"' })
    expect(refreshed).toMatchObject({ status: 206, etag, range: `bytes 0-9/${bytes.length}` })
  })

  it('normalizes character uploads before collision checks and rejects invalid paths without mutation', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')
    const base = server.url.replace('/mcp', '')
    const book = await callTool<BookPayload>(client, 'create_book', { name: 'HTTP character uploads' })
    const character = await callTool<{ asset_id: string }>(client, 'create_character', {
      book_id: book.bookId, args: ['Upload fixture'],
    })
    const upload = (filename: string, body: string, targetAssetId = character.asset_id) => fetch(
      `${base}/api/books/${book.bookId}/upload?${new URLSearchParams({ filename, targetAssetId })}`,
      { method: 'POST', body },
    )
    const first = await upload('notes.txt', 'Original character notes')
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ assetId: character.asset_id, filename: 'notes.txt' })
    for (const [filename, expected] of [
      ['notes.txt', 'notes-1.txt'], ['./notes.txt', 'notes-2.txt'],
      ['caps.TXT', 'caps.TXT'], ['caps.TXT', 'caps-1.TXT'],
    ]) {
      const duplicate = await upload(filename, expected)
      expect(duplicate.status).toBe(200)
      expect(await duplicate.json()).toMatchObject({ assetId: character.asset_id, filename: expected })
      expect(await (await fetch(`${base}/files/${book.bookId}/${character.asset_id}/${expected}`)).text()).toBe(expected)
    }
    const manifestUrl = `${base}/api/books/${book.bookId}/artifacts/${character.asset_id}/manifest`
    const before = await (await fetch(manifestUrl)).json()
    for (const filename of ['../escaped.txt', '..\\escaped.txt', '/absolute.txt', 'bad\0name.txt']) {
      const invalid = await upload(filename, 'Rejected bytes')
      expect(invalid.status, filename).toBe(400)
      expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('Invalid artifact file path') })
    }
    expect(await (await fetch(manifestUrl)).json()).toEqual(before)
    expect(await (await fetch(`${base}/files/${book.bookId}/${character.asset_id}/notes.txt`)).text()).toBe('Original character notes')
    const missing = await upload('notes.txt', 'Rejected bytes', 'missing-character')
    expect(missing.status).toBe(404)
  })

  it('rejects a foreign browser page while preserving browser and bundled extension access', async () => {
    if (!server) throw new Error('MCP server was not initialized')
    const base = server.url.replace('/mcp', '')
    await execFileAsync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'extension/vite.config.ts'])
    const extensionDir = join(process.cwd(), 'dist-extension')
    const context = await chromium.launchPersistentContext(join(rootDir, 'browser'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
        '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'],
    })
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
      expect(worker.url()).toBe(`${EXTENSION_ORIGIN}/background.js`)
      const extensionResult = await worker.evaluate(async (url) => {
        const response = await fetch(`${url}/healthz`)
        return { status: response.status, origin: response.headers.get('access-control-allow-origin'), body: await response.json() }
      }, base)
      expect(extensionResult.status).toBe(200)
      expect(extensionResult.body).toMatchObject({ ok: true })
      const extensionClient = new Client({ name: 'extension-http-fixture', version: '1' }, {
        capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      try {
        await extensionClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          fetch: async (input, init) => {
            const request = new Request(input, init)
            const result = await worker.evaluate(async (data) => {
              const response = await fetch(data.url, { method: data.method, headers: data.headers, ...(data.body ? { body: data.body } : {}) })
              return { status: response.status, headers: [...response.headers.entries()], body: await response.text() }
            }, { url: request.url, method: request.method, headers: [...request.headers.entries()], body: await request.text() })
            return new Response(result.body || null, { status: result.status, headers: result.headers })
          },
        }))
        expect((await extensionClient.callTool({ name: 'list_books', arguments: {} })).isError).not.toBe(true)
      } finally { await extensionClient.close() }
      const page = await context.newPage()
      await page.goto(`${base}/healthz`)
      expect(await page.evaluate(async (url) => (await fetch(`${url}/healthz`)).status, base)).toBe(200)
      await page.route('http://untrusted.example/', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Untrusted origin fixture</title>' }))
      await page.goto('http://untrusted.example/')
      const network = await context.newCDPSession(page)
      await network.send('Network.enable')
      const statuses: number[] = []
      network.on('Network.responseReceivedExtraInfo', (event) => statuses.push(event.statusCode))
      expect(await page.evaluate(async (url) => {
        try { return await (await fetch(`${url}/healthz`)).text() } catch { return 'blocked' }
      }, base)).toBe('blocked')
      await expect.poll(() => statuses).toContain(403)
    } finally { await context.close() }
  })

  it('renders media as data without script, form, or external resource access', async () => {
    if (!client || !server) throw new Error('MCP client was not initialized')
    const base = server.url.replace('/mcp', '')
    const book = await callTool<BookPayload>(client, 'create_book', { name: 'PRIVATE_MEDIA_FIXTURE' })
    const script = "document.documentElement.setAttribute('data-executed','yes');fetch('/mcp',{method:'POST',body:'{}'})"
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><style>rect { fill: rgb(255, 0, 0); }</style><rect width="20" height="20"/><script><![CDATA[${script}]]></script><image href="https://untrusted.example/track"/></svg>`
    const upload = await fetch(`${base}/api/books/${book.bookId}/upload?filename=active.svg`, { method: 'POST', body: svg })
    expect(upload.status).toBe(200)
    const asset = await upload.json() as { assetId: string }
    const svgPath = `${base}/files/${book.bookId}/${asset.assetId}/original.svg`
    await mkdir(join(rootDir, 'archive'), { recursive: true })
    await writeFile(join(rootDir, 'archive/active.html'), `<h1>Visible content</h1><script>${script}</script><form action="${base}/api/search-references" method="post"><button>Submit</button></form><img src="https://untrusted.example/track" onerror="${script}">`)
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const unexpected: string[] = []
      const violations: string[] = []
      const externalFailures: string[] = []
      page.on('requestfailed', (request) => {
        if (request.url().startsWith('https://untrusted.example')) externalFailures.push(request.failure()?.errorText ?? '')
      })
      page.on('request', (request) => {
        if (request.url().endsWith('/mcp') || request.url().includes('/api/search-references')) unexpected.push(request.url())
      })
      page.on('console', (message) => { if (message.type() === 'error') violations.push(message.text()) })
      const svgResponse = await page.goto(svgPath)
      expect(svgResponse?.status()).toBe(200)
      expect(svgResponse?.headers()['content-security-policy']).toContain('sandbox')
      expect(svgResponse?.headers()['content-security-policy']).not.toContain('allow-same-origin')
      expect(svgResponse?.headers()['x-content-type-options']).toBe('nosniff')
      expect(await page.locator('svg').getAttribute('data-executed')).toBeNull()
      expect(await page.locator('rect').evaluate((element) => getComputedStyle(element).fill)).toBe('rgb(255, 0, 0)')
      const archiveResponse = await page.goto(`${base}/archive-files/active.html`)
      expect(archiveResponse?.headers()['content-security-policy']).toContain('sandbox')
      expect(archiveResponse?.headers()['content-security-policy']).not.toContain('allow-same-origin')
      expect(archiveResponse?.headers()['x-content-type-options']).toBe('nosniff')
      expect(await page.locator('h1').textContent()).toBe('Visible content')
      expect(await page.locator('html').getAttribute('data-executed')).toBeNull()
      await page.getByRole('button', { name: 'Submit' }).click()
      expect(page.url()).toBe(`${base}/archive-files/active.html`)
      expect(unexpected).toEqual([])
      expect(externalFailures).toEqual([expect.stringMatching(/csp/i), expect.stringMatching(/csp/i)])
      expect(violations.some((message) => /script|sandbox|Content Security Policy/i.test(message))).toBe(true)
      await page.goto(`${base}/healthz`)
      await page.setContent(`<img src="${svgPath}">`)
      await expect.poll(() => page.locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(20)
      const videoPath = join(rootDir, 'safe-playback.mp4')
      await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
      const videoUpload = await fetch(`${base}/api/books/${book.bookId}/upload?filename=playback.mp4`, { method: 'POST', body: await readFile(videoPath) })
      expect(videoUpload.status).toBe(200)
      const video = await videoUpload.json() as { assetId: string }
      await page.setContent(`<video muted src="${base}/files/${book.bookId}/${video.assetId}/original.mp4"></video>`)
      const player = page.locator('video')
      await expect.poll(() => player.evaluate((element) => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
      await player.evaluate((element) => (element as HTMLVideoElement).play())
      await expect.poll(() => player.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
      const directVideoUrl = `${base}/files/${book.bookId}/${video.assetId}/original.mp4`
      await writeFile(join(rootDir, 'archive/playback.mp4'), await readFile(videoPath))
      const audioPath = join(rootDir, 'safe-playback.wav')
      await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audioPath])
      const audioBytes = await readFile(audioPath)
      const audioUpload = await fetch(`${base}/api/books/${book.bookId}/upload?filename=playback.wav`, { method: 'POST', body: audioBytes })
      expect(audioUpload.status).toBe(200)
      const audio = await audioUpload.json() as { assetId: string }
      await writeFile(join(rootDir, 'archive/playback.wav'), audioBytes)
      const webAudioPath = join(rootDir, 'safe-playback.weba')
      await execFileAsync(FFMPEG, ['-y', '-i', audioPath, '-c:a', 'libopus', '-f', 'webm', webAudioPath])
      const webAudioBytes = await readFile(webAudioPath)
      const webAudioUpload = await fetch(`${base}/api/books/${book.bookId}/upload?filename=playback.weba`, { method: 'POST', body: webAudioBytes })
      expect(webAudioUpload.status).toBe(200)
      const webAudio = await webAudioUpload.json() as { assetId: string }
      await writeFile(join(rootDir, 'archive/playback.weba'), webAudioBytes)
      for (const url of [
        `${directVideoUrl}?playback=direct`,
        `${base}/archive-files/playback.mp4`,
        `${base}/files/${book.bookId}/${audio.assetId}/original.wav`,
        `${base}/archive-files/playback.wav`,
        `${base}/files/${book.bookId}/${webAudio.assetId}/original.weba`,
        `${base}/archive-files/playback.weba`,
        directVideoUrl.replace('original.mp4', 'original%2Emp4'),
        `${base}/archive-files/playback%2Emp4`,
      ]) {
        const response = await page.goto(url)
        expect(response?.headers()['content-security-policy']).toContain('sandbox allow-same-origin')
        expect(response?.headers()['x-content-type-options']).toBe('nosniff')
        const directPlayer = page.locator('video, audio')
        await expect.poll(() => directPlayer.evaluate((element) =>
          (element as HTMLVideoElement).duration)).toBeCloseTo(1, 1)
        await directPlayer.evaluate(async (element) => {
          const video = element as HTMLVideoElement
          video.muted = true
          video.currentTime = 0
          await video.play()
        })
        await expect.poll(() => directPlayer.evaluate((element) =>
          (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
        expect(await directPlayer.evaluate((element) =>
          (element as HTMLVideoElement).error)).toBeNull()
        await directPlayer.evaluate((element) => {
          const media = element as HTMLMediaElement
          media.pause()
          media.currentTime = 0.5
        })
        await expect.poll(() => directPlayer.evaluate((element) =>
          (element as HTMLMediaElement).seeking)).toBe(false)
        expect(await directPlayer.evaluate((element) =>
          (element as HTMLMediaElement).currentTime)).toBeCloseTo(0.5, 1)
      }
    } finally { await browser.close() }
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
      defaultModel: 'gpt-6-astra',
      models: [
        expect.objectContaining({ id: 'gpt-6-astra', label: 'Astra' }),
      ],
    })

    const book = await callTool<BookPayload>(client, 'create_book', { name: 'mcp-story' })
    expect(book).toMatchObject({ name: 'mcp-story', bookId: expect.any(String) })

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
        label: 'prompt-opening',
        slot: { row: 0, column: 0 },
        prompt: 'A green city at sunrise',
      },
    })
    const image = await callTool<CellPayload>(client, 'create_notebook_cell', {
      book_id: book.bookId,
      notebook_id: notebook.id,
      cell: {
        type: 'generate_image',
        label: 'generate-image-opening',
        slot: { row: 0, column: 1 },
        prompt: 'A green city at sunrise',
        model: 'generate_kie_gpt_image_2_text_to_image',
      },
    })
    expect(image.output_cell).toBeUndefined()
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
      expect.objectContaining({
        id: prompt.id,
        label: 'prompt-opening',
        address: '@a1',
      }),
      expect.objectContaining({
        id: image.id,
        label: 'generate-image-opening',
        address: '@a2',
      }),
    ]))
    expect(document.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: prompt.id, target: image.id, targetInput: 'prompt' }),
    ]))
    expect(document.edges.some((edge) =>
      edge.source === image.id && edge.targetInput === 'media')).toBe(false)

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
    const upload = await uploaded.json() as { artifactId: string; assetId: string }
    expect(isUuidV7(upload.assetId)).toBe(true)
    expect(upload.artifactId).toBe(upload.assetId)

    const assets = await callTool<{ assets: AssetPayload[] }>(client, 'list_assets', {
      book_id: book.bookId,
    })
    const video = assets.assets.find((asset) => asset.id === upload.assetId)
    expect(video).toMatchObject({ artifact_id: upload.assetId, type: 'video' })
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
    expect(history.actions.map((action) => action.operation)).toEqual(
      expect.arrayContaining(['create_notebook_cell', 'connect_notebook_cells']),
    )
    const notebookWrites = history.actions.flatMap(
      (action) => action.details.writeSet ?? [],
    )
    expect(notebookWrites).toEqual(expect.arrayContaining([
      `cell:${notebook.id}:${prompt.id}`,
      `cell:${notebook.id}:${image.id}`,
    ]))
    expect(server.output.join('')).not.toContain('[mcp] history record failed')

    const deleted = await callTool<BookPayload>(client, 'delete_book', {
      book_id: book.bookId,
      confirm_name: 'mcp-story',
    })
    expect(deleted).toEqual({ bookId: book.bookId, name: 'mcp-story' })
  })
})

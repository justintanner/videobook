import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine } from '../../server/src/book-context.js'
import { EXTENSION_ORIGIN } from '../../server/src/http-access.js'
import { createHttpHandler, MCP_PROTOCOL_VERSION } from '../../server/src/server.js'

let root: string
let books: BookManager
let handler: ReturnType<typeof createHttpHandler>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'videobook-http-policy-'))
  books = new BookManager({ libraryDir: root })
  await books.ready()
  await books.create('PRIVATE_HTTP_FIXTURE')
  handler = createHttpHandler(scopedBookEngine, books)
})

afterAll(async () => {
  await handler?.close()
  await books?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

it.each([
  { origin: 'https://untrusted.example' },
  { origin: 'null' },
  { origin: 'http://localhost.untrusted.example' },
  { origin: 'http://localhost@untrusted.example' },
  { origin: 'http://untrusted.example@localhost' },
  { origin: 'http://localhost/' },
  { origin: 'http://localhost:99999' },
  { origin: 'http://localhost http://127.0.0.1' },
  { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { host: 'untrusted.example', origin: 'http://localhost:5173' },
  { host: 'localhost.untrusted.example' },
  { host: 'localhost@untrusted.example' },
  { host: 'localhost:3001, untrusted.example' },
  { host: 'localhost:99999' },
  { 'sec-fetch-site': 'cross-site' },
])('rejects an untrusted request before MCP discovery: %j', async (headers) => {
  const requestHeaders = new Headers()
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) requestHeaders.set(name, value)
  const request = new Request('http://localhost:3001/mcp', {
    method: 'POST', headers: requestHeaders,
    body: '{invalid-json',
  })
  const response = await handler.fetch(request)
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('private-http-fixture')
})

it.each([
  'http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:5173',
  'https://localhost:5173', EXTENSION_ORIGIN, undefined,
])('preserves actual native/local/extension MCP discovery and tools: %s', async (origin) => {
  const client = new Client({ name: 'http-policy', version: '1' }, {
    capabilities: {}, supportedProtocolVersions: [MCP_PROTOCOL_VERSION],
    versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
  })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'), {
      fetch: (input, init) => {
        const request = new Request(input, init)
        if (origin) request.headers.set('origin', origin)
        return handler.fetch(request)
      },
    }))
    const result = await client.callTool({ name: 'list_books', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain('private-http-fixture')
  } finally { await client.close() }
})

it('rejects a rebinding URL even when a local Host header is supplied', async () => {
  const result = await handler.fetch(new Request('http://untrusted.example/mcp', { headers: { host: 'localhost' } }))
  expect(result.status).toBe(403)
})

it('pins the allowed extension origin to the bundled public key', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8')) as { key: string }
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  const id = [...hex].map((value) => String.fromCharCode(97 + parseInt(value, 16))).join('')
  expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${id}`)
})

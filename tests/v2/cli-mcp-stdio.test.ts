import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, it } from 'vitest'
import { availablePort } from './e2e-harness.js'
import { callTool } from './mcp-http-test-server.js'
import { cleanupCli, cliEnv, connectMcp, spawnCli, stopCli, tempDir, waitForHealth } from './cli-harness.js'

interface StdioSession {
  client: Client
  transport: StdioClientTransport
  stderr: string[]
  errors: Error[]
}

const sessions: StdioSession[] = []

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function openStdio(args: string[], negotiation: 'pinned' | 'default'): Promise<StdioSession> {
  const client = new Client({ name: 'videobook-stdio-test', version: '1' }, negotiation === 'pinned'
    ? { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } }
    : { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'server/src/cli/entry.ts', 'mcp', ...args],
    cwd: process.cwd(),
    env: cliEnv() as Record<string, string>,
    stderr: 'pipe',
  })
  const stderr: string[] = []
  transport.stderr?.on('data', (data: Buffer) => stderr.push(data.toString()))
  const errors: Error[] = []
  client.onerror = (error) => errors.push(error)
  const session = { client, transport, stderr, errors }
  sessions.push(session)
  await client.connect(transport)
  return session
}

async function closeStdio(session: StdioSession): Promise<void> {
  const pid = session.transport.pid
  await session.client.close()
  if (pid !== null) await expect.poll(() => processGone(pid), { timeout: 10_000 }).toBe(true)
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort()
}

describe('videobook mcp', () => {
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.client.close().catch(() => undefined)
    await cleanupCli()
  })

  it('serves stdio from an in-process owner that also serves HTTP, and exits when stdin closes', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    const port = await availablePort()
    const base = `http://127.0.0.1:${port}`
    const stdio = await openStdio(['--port', String(port), '--home', home], 'pinned')

    const names = await toolNames(stdio.client)
    expect(names.length).toBeGreaterThan(100)
    expect(stdio.client.getInstructions()).toContain(base)
    const http = await connectMcp(`${base}/mcp`)
    try {
      expect(names).toEqual(await toolNames(http))
      const created = JSON.parse((await stdio.client.callTool({ name: 'create_book', arguments: { name: 'stdio-owner' } })).content
        .find((item) => item.type === 'text')?.text ?? '{}') as { bookId: string }
      expect(await callTool<Array<{ bookId: string }>>(http, 'list_books', {}))
        .toEqual([expect.objectContaining({ bookId: created.bookId })])
    } finally {
      await http.close()
    }
    expect(stdio.stderr.join('')).toContain(`serving stdio; web UI and HTTP MCP at ${base}/`)
    expect(stdio.errors).toEqual([])

    await closeStdio(stdio)
    await expect(access(join(home, 'books', '.videobook-server.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('relays stdio to a running owner for clients that negotiate the legacy way', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    const port = await availablePort()
    const base = `http://127.0.0.1:${port}`
    const owner = spawnCli(['serve', '--headless', '--port', String(port), '--home', home])
    await waitForHealth(base, owner)

    const stdio = await openStdio(['--home', home], 'default')
    const http = await connectMcp(`${base}/mcp`)
    try {
      expect(await toolNames(stdio.client)).toEqual(await toolNames(http))
      const created = JSON.parse((await stdio.client.callTool({ name: 'create_book', arguments: { name: 'stdio-relay' } })).content
        .find((item) => item.type === 'text')?.text ?? '{}') as { bookId: string }
      expect(await callTool<Array<{ bookId: string }>>(http, 'list_books', {}))
        .toEqual([expect.objectContaining({ bookId: created.bookId })])
      const invalid = await stdio.client.callTool({ name: 'create_book', arguments: { name: 42 } })
      expect(invalid.isError).toBe(true)
    } finally {
      await http.close()
    }
    expect(stdio.stderr.join('')).toContain(`relaying stdio to ${base}/mcp (pid ${owner.child.pid})`)
    expect(stdio.errors).toEqual([])

    await closeStdio(stdio)
    expect((await fetch(`${base}/healthz`)).ok).toBe(true)
    expect(await stopCli(owner)).toBe(0)
  }, 120_000)
})

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { availablePort } from './e2e-harness.js'
import { callTool } from './mcp-http-test-server.js'
import { cleanupCli, connectMcp, runCli, spawnCli, stopCli, tempDir, waitForHealth } from './cli-harness.js'

describe('videobook run, tools and gc-books', () => {
  afterEach(cleanupCli)

  it('runs a tool on a temporary owner, prints only the result, and leaves nothing running', async () => {
    const home = join(await tempDir(), 'home')
    const result = await runCli(['run', 'create_book', 'name=cli-run', '--home', home])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ name: 'cli-run', bookId: expect.any(String) })
    expect(result.stderr).toContain('[shutdown-complete]')
    await expect(access(join(home, 'books', '.videobook-server.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const listed = await runCli(['run', 'list_books', '--home', home])
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ name: 'cli-run' })])
  }, 120_000)

  it('calls tools through a running owner and refuses gc-books while it runs', async () => {
    const home = join(await tempDir(), 'home')
    const port = await availablePort()
    const base = `http://127.0.0.1:${port}`
    const owner = spawnCli(['serve', '--headless', '--port', String(port), '--home', home])
    await waitForHealth(base, owner)

    const created = await runCli(['run', 'create_book', 'name=via-owner', '--home', home])
    expect(created.code).toBe(0)
    const book = JSON.parse(created.stdout) as { bookId: string }
    const http = await connectMcp(`${base}/mcp`)
    try {
      expect(await callTool<Array<{ bookId: string }>>(http, 'list_books', {}))
        .toEqual([expect.objectContaining({ bookId: book.bookId })])
    } finally {
      await http.close()
    }
    expect(JSON.parse(await readFile(join(home, 'books', '.videobook-server.json'), 'utf8'))).toMatchObject({ pid: owner.child.pid })

    const gc = await runCli(['gc-books', '--home', home])
    expect(gc.code).toBe(1)
    expect(gc.stderr).toContain(`videobook is running at ${base} (pid ${owner.child.pid}); stop it before collecting catalog garbage.`)
    expect(await stopCli(owner)).toBe(0)

    const collected = await runCli(['gc-books', '--home', home])
    expect(collected.code).toBe(0)
    expect(JSON.parse(collected.stdout)).toEqual({ catalogs: [expect.objectContaining({ bookId: book.bookId })] })
  }, 120_000)

  it('reports unknown tools and invalid arguments with exit code 1', async () => {
    const home = join(await tempDir(), 'home')
    const unknown = await runCli(['run', 'nope_tool', '--home', home])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('Tool nope_tool not found')
    const invalid = await runCli(['run', 'create_book', 'name=42', '--home', home])
    expect(invalid.code).toBe(1)
    expect(invalid.stdout).toBe('')
  }, 120_000)

  it('lists tools without opening the library', async () => {
    const home = join(await tempDir(), 'home')
    const result = await runCli(['tools', '--home', home])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('create_book <name>')
    expect(result.stdout).toContain('list_books')
    await expect(access(join(home, 'books'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})

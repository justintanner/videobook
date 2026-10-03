import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager'
import { createHttpHandler } from '../../server/src/server'
import { scopedBookEngine } from '../../server/src/book-context'
import { availablePort, startProcess, stopProcess, waitForHttp, toolCalls, requestBody } from './e2e-harness'
import type { StartedProcess } from './e2e-harness'

describe('book usage counter in the real browser', () => {
  let root: string
  let books: BookManager
  let engine: Engine
  let secondId: string
  let server: Server
  let vite: StartedProcess
  let browser: Browser
  let page: Page
  let appUrl: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vb-usage-browser-'))
    books = new BookManager({ libraryDir: join(root, 'books') })
    await books.ready()
    const first = await books.create('usage-story')
    const second = await books.create('empty-story')
    if (!first.ok || !second.ok) throw new Error('Could not create usage books')
    const scoped = books.get(first.value.bookId)
    if (!scoped.ok) throw new Error(scoped.error.message)
    engine = scoped.value.engine
    secondId = second.value.bookId
    engine.usage.record({ id: 'initial', provider: 'openai', model: 'gpt-4o', activity: 'chat', status: 'completed', basis: 'estimated', costUsd: 1.25, tokenBased: true, inputTokens: 1500, outputTokens: 500, cachedTokens: 300 })
    const mcp = toNodeHandler(createHttpHandler(scopedBookEngine, books))
    const app = express()
    app.use(express.json())
    app.all('/mcp', (request, response) => { void mcp(request, response, request.body) })
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing MCP port')
    appUrl = `http://127.0.0.1:${await availablePort()}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(appUrl).port, '--strictPort'], {
      ...process.env, VIDEOBOOK_SERVER_URL: `http://127.0.0.1:${address.port}`, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript((bookId) => { localStorage.setItem('videobook.active-book', bookId) }, first.value.bookId)
    await page.goto(appUrl)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await stopProcess(vite)
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await books?.close()
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('updates totals, preserves usage on reload, and keeps the popover and both metrics inside the header', async () => {
    const trigger = page.getByRole('button', { name: /^Book usage:/ })
    await expect.poll(() => trigger.innerText(), { timeout: 30_000 }).toContain('~$1.25')
    expect(await trigger.innerText()).toContain('2K')
    await trigger.click()
    const panel = page.getByRole('dialog', { name: 'Book usage' })
    await expect.poll(() => panel.isVisible()).toBe(true)
    expect(await panel.innerText()).toContain('1,500 / 500')
    expect(await panel.innerText()).toContain('Tracked since')
    await page.keyboard.press('Escape')
    await expect.poll(() => trigger.evaluate((node) => node === document.activeElement)).toBe(true)
    engine.usage.record({ id: 'video', provider: 'fal', model: 'video-model', activity: 'video', status: 'completed', basis: 'reported', costUsd: 12 })
    engine.usage.record({ id: 'unknown', provider: 'xai', model: 'voice-model', activity: 'voice', status: 'completed', basis: 'unknown', inputTokens: 10, outputTokens: 5, tokenBased: true })
    await expect.poll(() => trigger.innerText(), { timeout: 8_000 }).toContain('~$13.25')
    await page.reload()
    await expect.poll(() => trigger.innerText(), { timeout: 30_000 }).toContain('~$13.25')
    for (const [width, height] of [[1440, 900], [768, 900], [390, 844], [320, 568]]) {
      await page.setViewportSize({ width: width!, height: height! })
      await trigger.click()
      await expect.poll(() => panel.isVisible()).toBe(true)
      const bounds = await trigger.boundingBox()
      const popup = await panel.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!)
      expect(popup!.x).toBeGreaterThanOrEqual(0)
      expect(popup!.x + popup!.width).toBeLessThanOrEqual(width!)
      expect(popup!.y + popup!.height).toBeLessThanOrEqual(height!)
      expect(await panel.innerText()).toContain('1 request has an unavailable price')
      if (width === 1440 || width === 390) {
        await mkdir('test-results/usage', { recursive: true })
        await page.screenshot({ path: `test-results/usage/counter-${width}.png` })
      }
      await page.keyboard.press('Escape')
    }
  })

  it('ignores stale book responses and retains the current total through a transport failure', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    let release: (() => void) | undefined
    let held = false
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/mcp', async (route) => {
      const calls = toolCalls(await requestBody(route))
      if (!held && calls.some((call) => call.name === 'get_book_usage' && call.arguments.book_id === engine.book.get().bookId)) {
        held = true
        const actual = await route.fetch()
        await pending
        await route.fulfill({ response: actual })
      } else await route.continue()
    })
    try {
      await expect.poll(() => held, { timeout: 8_000 }).toBe(true)
      await page.locator('.brand-project-menu-toggle').click()
      await page.getByRole('menuitem', { name: /empty-story/ }).click()
      const trigger = page.getByRole('button', { name: /^Book usage:/ })
      await expect.poll(() => trigger.innerText(), { timeout: 15_000 }).toContain('$0.00')
      release?.()
      await expect.poll(() => page.evaluate(() => localStorage.getItem('videobook.active-book'))).toBe(secondId)
      expect(await trigger.innerText()).toContain('$0.00')
      await page.unroute('**/mcp')
      let failed = false
      await page.route('**/mcp', async (route) => {
        if (!failed && toolCalls(await requestBody(route)).some((call) => call.name === 'get_book_usage')) {
          failed = true
          await route.abort()
        } else await route.continue()
      })
      await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 8_000 }).toContain('stale')
      expect(await trigger.innerText()).toContain('$0.00')
      await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 8_000 }).not.toContain('stale')
    } finally {
      release?.()
      await page.unroute('**/mcp')
    }
  })
})

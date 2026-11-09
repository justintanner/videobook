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
import { testBudget } from '../../server/src/test-budget'
import { availablePort, startProcess, stopProcess, waitForHttp, toolCalls, requestBody } from './e2e-harness'
import type { StartedProcess } from './e2e-harness'

const FAL_AVERAGE_WARNING = "fal pricing estimate for 'minimax/h3-max/extend-video' is fal's historical average per call x 1; it ignores this request's payload"
const COST_VIEWPORTS = [[1474, 810], [1280, 720], [1024, 600]] as const
const PANEL_MIN_HEIGHT = 240

interface CellCostLayout {
  panelHeights: number[]
  panelBottom: number
  formBottom: number
  costTop: number
  costBottom: number
  costHeight: number
  bodyBottom: number
  open: boolean
  lastCallInside: boolean
}

function cellCostLayout(): CellCostLayout {
  const box = (selector: string): DOMRect => document.querySelector(selector)!.getBoundingClientRect()
  const panels = [...document.querySelectorAll('.generation-cell-inspector .confirm-generation > .confirm-section:not([hidden])')]
    .map((panel) => panel.getBoundingClientRect())
  const cost = box('.generation-cell-inspector > .usage-cost-scopes')
  const lastCall = [...document.querySelectorAll('.generation-cell-inspector .usage-cost-call')].at(-1)?.getBoundingClientRect()
  return {
    panelHeights: panels.map((panel) => panel.height),
    panelBottom: Math.max(...panels.map((panel) => panel.bottom)),
    formBottom: box('.generation-cell-form').bottom,
    costTop: cost.top,
    costBottom: cost.bottom,
    costHeight: cost.height,
    bodyBottom: box('.generation-cell-inspector').bottom,
    open: document.querySelector<HTMLDetailsElement>('.generation-cell-inspector .usage-cost-details')?.open === true,
    lastCallInside: lastCall !== undefined && lastCall.top >= cost.top - 1 && lastCall.bottom <= cost.bottom + 1,
  }
}

function recordCellCalls(engine: Engine, cellId: string, from: number, to: number): void {
  for (let index = from; index < to; index += 1) {
    const written = engine.usage.record({
      id: `cell-call-${index}`, provider: 'fal', model: 'minimax/h3-max/extend-video', activity: 'video', status: 'completed',
      basis: 'estimated', actualBasis: 'none', costUsd: 0.32, warnings: [FAL_AVERAGE_WARNING], cellId, createdAt: 100 + index,
    })
    if (!written.ok) throw new Error(written.error.message)
  }
}

function expectPanelsClearOfCost(layout: CellCostLayout, label: string): void {
  expect(layout.panelHeights, label).toHaveLength(3)
  expect(Math.min(...layout.panelHeights), label).toBeGreaterThanOrEqual(PANEL_MIN_HEIGHT - 0.5)
  expect(layout.panelBottom, label).toBeLessThanOrEqual(layout.formBottom + 0.5)
  expect(layout.costTop, label).toBeGreaterThanOrEqual(layout.panelBottom - 0.5)
}

async function expectCostLayoutAt(page: Page, width: number, height: number, calls: number): Promise<void> {
  const label = `${calls} usage rows at ${width}x${height}`
  const summary = page.locator('.generation-cell-inspector .usage-cost-details > summary')
  await page.setViewportSize({ width, height })
  const folded = await page.evaluate(cellCostLayout)
  expect(folded.open, label).toBe(false)
  expectPanelsClearOfCost(folded, `${label}, folded`)
  expect(folded.costHeight, label).toBeLessThanOrEqual(32)
  expect(folded.costBottom, label).toBeLessThanOrEqual(folded.bodyBottom + 0.5)
  await summary.click()
  await page.locator('.generation-cell-inspector .usage-cost-call').last().scrollIntoViewIfNeeded()
  const opened = await page.evaluate(cellCostLayout)
  expect(opened.open, label).toBe(true)
  expectPanelsClearOfCost(opened, `${label}, opened`)
  expect(opened.lastCallInside, label).toBe(true)
  await summary.press('Enter')
}

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
    const quote = panel.getByRole('region', { name: 'Estimate against actual' })
    expect(await quote.innerText()).toContain('~$1.25')
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
      expect(await quote.innerText()).toContain('Partial: 2 of 3 calls settled, 1 call unpriced')
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

  it('keeps the cell cost clear of the generation editor panels, folded until it is opened', async () => {
    const notebook = engine.notebooks.list()[0]!
    const priced = engine.notebooks.createCell({ type: 'generate_video', slot: { row: 0, column: 0 }, prompt: 'A fox crosses the road' })
    const unused = engine.notebooks.createCell({ type: 'generate_video', slot: { row: 0, column: 1 }, prompt: 'A heron waits' })
    for (const cell of [priced, unused]) {
      const inserted = await engine.notebooks.insertCell(notebook.id, cell)
      if (!inserted.ok) throw new Error(inserted.error.message)
    }
    const node = (cellId: string) => page.locator(`.notebook-flow .react-flow__node[data-id="${cellId}"] .cell-node`)
    const inspector = page.locator('.generation-cell-inspector')
    const scopes = inspector.locator('> .usage-cost-scopes')
    const summary = inspector.locator('.usage-cost-details > summary')
    await page.setViewportSize({ width: 1474, height: 810 })
    await page.reload()

    await node(unused.id).click({ timeout: testBudget(60_000) })
    await expect.poll(() => scopes.count(), { timeout: testBudget(30_000) }).toBe(1)
    expect(await scopes.isVisible()).toBe(false)
    const bare = await page.evaluate(() => ({
      panelBottom: document.querySelector('.generation-cell-inspector .generation-review-source-section')!.getBoundingClientRect().bottom,
      bodyBottom: document.querySelector('.generation-cell-inspector')!.getBoundingClientRect().bottom,
    }))
    expect(bare.bodyBottom - bare.panelBottom).toBeLessThanOrEqual(8.5)

    await node(priced.id).click()
    let recorded = 0
    for (const calls of [1, 3, 12]) {
      recordCellCalls(engine, priced.id, recorded, calls)
      recorded = calls
      await expect.poll(() => summary.innerText(), { timeout: testBudget(15_000) }).toBe(calls === 1 ? '1 call' : `${calls} calls`)
      for (const [width, height] of COST_VIEWPORTS) await expectCostLayoutAt(page, width, height, calls)
    }
    expect(await inspector.locator('.usage-cost-total').innerText()).toContain('Cell cost')
    expect(await inspector.locator('.usage-cost-partial').innerText()).toBe('Partial: 0 of 12 calls settled')

    await page.setViewportSize({ width: 1474, height: 810 })
    await page.locator('.inspector').getByRole('button', { name: 'View source', exact: true }).click()
    await inspector.locator('.confirm-generation[data-view="source"]').waitFor({ state: 'visible', timeout: testBudget(15_000) })
    await summary.click()
    expectPanelsClearOfCost(await page.evaluate(cellCostLayout), 'source view, opened')
  }, testBudget(240_000))
})

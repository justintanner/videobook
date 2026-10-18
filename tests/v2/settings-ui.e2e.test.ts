import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MANAGED_ENV_KEYS } from '../../server/src/env-secrets.js'
import { availablePort, record, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const MCP_ROUNDTRIP_MS = 15_000

describe('Settings through the real application', () => {
  let rootDir = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let page: Page
  let client: Client
  let appUrl = ''
  let bookId = ''

  async function call(name: string, args: Record<string, unknown> = {}) {
    return resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } }))
  }

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-settings-e2e-'))
    const mcpPort = await availablePort()
    const vitePort = await availablePort()
    const origin = `http://127.0.0.1:${mcpPort}`
    appUrl = `http://127.0.0.1:${vitePort}`
    const env = {
      ...process.env,
      ...Object.fromEntries(MANAGED_ENV_KEYS.map(key => [key, ''])),
      KIMI_CODING_API_KEY: 'fixture-managed-key',
      PORT: String(mcpPort),
      VIDEOBOOK_ENV_PATH: join(rootDir, '.env'),
      VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
      VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime/app-state.json'),
      VIDEOBOOK_VITE_CACHE_DIR: join(rootDir, 'vite-cache'),
      VIDEOBOOK_VITE_HMR: '0',
    }
    await writeFile(env.VIDEOBOOK_ENV_PATH, '')
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'settings-ui-e2e', version: '1.0.0' }, {
      capabilities: {},
      supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    bookId = String(record(await call('create_book', { name: 'settings-project' }))?.bookId)
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      ...env, VIDEOBOOK_SERVER_URL: origin,
    })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    await page.getByLabel('Open Settings', { exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    await page.getByText('Up to date', { exact: true }).waitFor()
  })

  afterEach(async () => { await page?.close() })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    await rm(rootDir, { recursive: true, force: true })
  })

  it('records the full-registry desktop layout', async () => {
    const status = record(await call('provider_key_status'))
    expect(Array.isArray(status?.providers) ? status.providers.length : 0).toBe(17)
    const evidenceDir = process.env.VIDEOBOOK_UI_EVIDENCE_DIR ?? join(rootDir, 'evidence')
    await mkdir(evidenceDir, { recursive: true })
    const measurements = []
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
      await page.setViewportSize(viewport)
      const measurement = await page.locator('.workspace-screen').evaluate(element => ({
        width: element.clientWidth,
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
      }))
      measurements.push({ viewport, ...measurement })
      const composer = await page.locator('.command-line-shell').boundingBox()
      for (const heading of ['Providers', 'X account', 'Storage']) {
        const bounds = await page.getByRole('heading', { name: heading, exact: true }).boundingBox()
        expect(bounds?.y).toBeGreaterThan(0)
        expect(bounds!.y + bounds!.height).toBeLessThan(composer!.y)
      }
      for (const button of await page.locator('.settings-providers button').all()) {
        const bounds = await button.boundingBox()
        expect(bounds!.y + bounds!.height).toBeLessThan(composer!.y)
      }
      await page.screenshot({ path: join(evidenceDir, `settings-${viewport.width}.png`), fullPage: true })
    }
    await writeFile(join(evidenceDir, 'settings-measurements.json'), JSON.stringify(measurements, null, 2))
  })

  it('edits the chosen key, retains drafts through refresh, and reports real save failures', async () => {
    const edit = page.getByRole('button', { name: 'Edit FAL', exact: true })
    await edit.click()
    const form = page.getByRole('form', { name: 'Edit FAL', exact: true })
    const value = form.getByLabel('FAL', { exact: true })
    expect(await value.getAttribute('type')).toBe('password')
    await expect.poll(() => value.evaluate(element => document.activeElement === element)).toBe(true)
    await value.fill('test-draft')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Up to date', { exact: true }).waitFor()
    expect(await value.inputValue()).toBe('test-draft')
    await form.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => edit.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await readFile(join(rootDir, '.env'), 'utf8')).not.toContain('FAL_API_KEY')

    await edit.click()
    expect(await value.inputValue()).toBe('')
    await value.fill('test-both\'"quotes')
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'both single and double quotes' }).waitFor()
    expect(await value.inputValue()).toBe('test-both\'"quotes')
    expect(await readFile(join(rootDir, '.env'), 'utf8')).not.toContain('FAL_API_KEY')

    const secret = 'settings-fixture-private-value'
    await value.fill(secret)
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('FAL saved', { exact: true }).waitFor()
    await expect.poll(() => edit.evaluate(element => document.activeElement === element)).toBe(true)
    const status = JSON.stringify(await call('provider_key_status'))
    expect(status).not.toContain(secret)
    expect(await page.locator('.settings-screen').textContent()).not.toContain(secret)
    expect(await readFile(join(rootDir, '.env'), 'utf8')).toContain(`FAL_API_KEY=${secret}`)
    await edit.click()
    expect(await value.inputValue()).toBe('')
    await value.press('Escape')
    await expect.poll(() => edit.evaluate(element => document.activeElement === element)).toBe(true)
  })

  it('keeps managed credentials read only and names all X and storage fields', async () => {
    const managed = page.getByRole('article', { name: 'Kimi Coding setting', exact: true })
    expect(await managed.textContent()).toContain('Managed in 1Password')
    expect(await managed.getByRole('button').count()).toBe(0)
    const xDetails = page.locator('.settings-details').filter({ has: page.locator('summary', { hasText: /^X credentials/ }) })
    await xDetails.locator('summary').click()
    await page.getByRole('button', { name: 'Edit X client ID', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Edit X client secret', exact: true }).waitFor()
    const b2 = page.locator('.settings-details').filter({ has: page.locator('summary', { hasText: 'Backblaze configuration' }) })
    await b2.locator('summary').click()
    expect(await page.locator('.settings-credential').count()).toBe(17)
    await b2.getByRole('button', { name: 'Edit Region', exact: true }).click()
    expect(await b2.getByLabel('Region', { exact: true }).getAttribute('type')).toBe('text')
    await b2.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByText('Technical details', { exact: true }).click()
    const storage = await call('storage_status')
    const json = await page.locator('.settings-details pre').textContent()
    expect(JSON.parse(json ?? '')).toEqual(storage)
  })

  it('keeps expanded settings reachable in narrow, short and zoomed windows', async () => {
    const sizes = [
      { width: 1024, height: 500 },
      { width: 667, height: 375 },
      { width: 390, height: 844 },
      { width: 320, height: 640 },
    ]
    for (const size of sizes) {
      await page.setViewportSize(size)
      const screen = page.locator('.settings-screen')
      expect(await screen.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const edit = page.getByRole('button', { name: 'Edit DashScope', exact: true })
      await edit.click()
      const form = page.getByRole('form', { name: 'Edit DashScope', exact: true })
      const input = form.getByLabel('DashScope', { exact: true })
      await input.fill('test-narrow-key')
      const save = form.getByRole('button', { name: 'Save', exact: true })
      await save.scrollIntoViewIfNeeded()
      const bounds = await save.boundingBox()
      const composer = await page.locator('.command-line-shell').boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
      expect(bounds!.y + bounds!.height).toBeLessThan(composer!.y)
      expect(await save.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
      })).toBe(true)
      await form.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.poll(() => edit.evaluate(element => document.activeElement === element)).toBe(true)
      await screen.evaluate(element => { element.scrollTop = 0 })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('html').evaluate(element => { element.style.zoom = '2' })
    expect(await page.locator('.settings-screen').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const first = page.getByRole('button', { name: 'Edit Kie', exact: true })
    await first.focus()
    await first.press('Enter')
    const form = page.getByRole('form', { name: 'Edit Kie', exact: true })
    const input = form.getByLabel('Kie', { exact: true })
    await expect.poll(() => input.evaluate(element => document.activeElement === element)).toBe(true)
    await input.fill('test-zoom')
    await input.press('Tab')
    await expect.poll(() => form.getByRole('button', { name: 'Save', exact: true }).evaluate(element => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => input.evaluate(element => document.activeElement === element)).toBe(true)
    await input.press('Escape')
    await expect.poll(() => first.evaluate(element => document.activeElement === element)).toBe(true)
  })

  it('shows actual storage for the selected project after a project switch', async () => {
    const second = record(await call('create_book', { name: 'settings-second' }))
    const secondId = String(second?.bookId)
    let held = false
    let release = () => {}
    let finished = false
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/mcp', async route => {
      const body = route.request().postData()
      if (!held && body && toolCalls(JSON.parse(body)).some(call => call.name === 'storage_status')) {
        held = true
        const response = await route.fetch()
        await gate
        await route.fulfill({ response })
        finished = true
      } else await route.continue()
    })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    await page.locator('.brand-project-menu-toggle').click()
    await page.locator('.book-project-select').filter({ hasText: 'settings-second' }).click()
    await expect.poll(() => page.locator('.book-project-menu').count()).toBe(0)
    await expect.poll(() => page.getByLabel('Videobook command input', { exact: true }).isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    await page.getByLabel('Open Settings', { exact: true }).click()
    await page.getByText('Up to date', { exact: true }).waitFor()
    const storagePanel = page.getByRole('region', { name: 'Storage', exact: true })
    expect(await storagePanel.textContent()).toContain('settings-second')
    expect(await storagePanel.textContent()).not.toContain('settings-project')
    await page.getByText('Technical details', { exact: true }).click()
    expect(JSON.parse(await storagePanel.locator('pre').textContent() ?? '')).toEqual(await call('storage_status', { book_id: secondId }))
    release()
    await expect.poll(() => finished).toBe(true)
    expect(JSON.parse(await storagePanel.locator('pre').textContent() ?? '')).toEqual(await call('storage_status', { book_id: secondId }))
  })

  it('shows section failures and recovers without losing an edited draft', async () => {
    await page.getByRole('button', { name: 'Edit FAL', exact: true }).click()
    const value = page.getByRole('form', { name: 'Edit FAL', exact: true }).getByLabel('FAL', { exact: true })
    await value.fill('test-retained-draft')
    let failedTool = 'provider_key_status'
    await page.route('**/mcp', async route => {
      const body = route.request().postData()
      if (body && toolCalls(JSON.parse(body)).some(call => call.name === failedTool)) await route.abort('failed')
      else await route.continue()
    })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.locator('.settings-screen > .settings-error').waitFor()
    expect(await value.inputValue()).toBe('test-retained-draft')
    const storage = page.getByRole('region', { name: 'Storage', exact: true })
    failedTool = ''
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Up to date', { exact: true }).waitFor()
    await storage.getByText('Pending objects', { exact: true }).waitFor()
    failedTool = 'storage_status'
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await storage.getByRole('alert').waitFor()
    expect(await storage.locator('pre').count()).toBe(0)
    expect(await value.inputValue()).toBe('test-retained-draft')
    await page.unroute('**/mcp')
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Up to date', { exact: true }).waitFor()
    expect(await value.inputValue()).toBe('test-retained-draft')
    expect(await page.locator('.settings-screen [role="alert"]').count()).toBe(0)
    await storage.getByText('Pending objects', { exact: true }).waitFor()
  })

  it('keeps X authorization pending and rejected states usable without contacting X', async () => {
    await call('set_env_secret', { key: 'X_CLIENT_ID', value: 'test-x-client' })
    await call('set_env_secret', { key: 'X_CLIENT_SECRET', value: 'test-x-client-secret' })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Up to date', { exact: true }).waitFor()
    await page.context().route('https://x.com/**', route => route.abort())
    const popupPromise = page.waitForEvent('popup')
    await page.locator('.x-connection-card button').click()
    const popup = await popupPromise
    await popup.close()
    const fallback = page.getByRole('link', { name: 'Open the X authorization page', exact: true })
    await fallback.waitFor()
    expect(await page.getByRole('button', { name: 'Waiting…', exact: true }).isDisabled()).toBe(true)
    const authorize = new URL(await fallback.getAttribute('href') ?? '')
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '')
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
    callback.searchParams.set('error', 'access_denied')
    for (const viewport of [{ width: 390, height: 844 }, { width: 667, height: 375 }]) {
      await page.setViewportSize(viewport)
      await fallback.scrollIntoViewIfNeeded()
      expect(await page.locator('.settings-screen').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const bounds = await fallback.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    }
    expect((await fetch(callback)).status).toBe(400)
    await page.locator('.x-connection-error').filter({ hasText: 'invalid state or missing code' }).waitFor()
    await expect.poll(() => page.locator('.x-connection-card button').isEnabled(), { timeout: MCP_ROUNDTRIP_MS }).toBe(true)
    expect(await page.locator('.settings-screen').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  })

  it('keeps application settings available without a selected project', async () => {
    const books = await call('list_books')
    expect(Array.isArray(books)).toBe(true)
    for (const book of Array.isArray(books) ? books : []) {
      await call('delete_book', { book_id: record(book)?.bookId, confirm_name: record(book)?.name })
    }
    await page.goto(`${appUrl}/settings`)
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
    await page.getByText('Select a project to inspect its storage.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByText('Up to date', { exact: true }).waitFor()
    expect(await page.locator('.settings-credential').count()).toBe(17)
    await page.getByRole('button', { name: 'Edit FAL', exact: true }).click()
    await page.getByRole('form', { name: 'Edit FAL', exact: true }).getByLabel('FAL', { exact: true }).fill('test-no-project')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
})

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { decodeHeicToPng } from '../../server/src/image.js'
import { registerPrepareSearchReferenceJob } from '../../server/src/jobs/prepare-search-reference.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'
import { searchReferenceStore } from '../../server/src/search-reference-store.js'
import type { SearchReferenceDescriptor } from '../../server/src/search-reference-store.js'
import { availablePort, resultValue, startProcess, stopProcess, waitForHttp } from './e2e-harness'
import type { StartedProcess } from './e2e-harness'

const timeout = 60_000
const fixturePath = new URL('../fixtures/images/portrait.heic', import.meta.url)

describe.runIf(process.env.VIDEOBOOK_RUN_MODEL_E2E === '1')('HEIC temporary reverse search with the local model', () => {
  it('keeps original fingerprints for staged and managed images and cleans uploads on success and decode failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videobook-heic-reference-job-'))
    const books = new BookManager({ libraryDir: join(root, 'books') })
    try {
      const created = await books.create('heic-reference-job')
      if (!created.ok) throw new Error(created.error.message)
      const managed = books.get(created.value.bookId)
      if (!managed.ok) throw new Error(managed.error.message)
      const { engine, rootDir } = managed.value
      const before = engine.artifacts.list()
      await setEngineRoot(rootDir, engine)
      registerPrepareSearchReferenceJob(engine)
      const original = await readFile(fixturePath)
      for (const [index, bytes] of [original, Buffer.from('broken HEIC')].entries()) {
        const cleanupRoot = await mkdtemp(join(root, 'upload-'))
        const uploadPath = join(cleanupRoot, 'reference.HEIC')
        await writeFile(uploadPath, bytes)
        const result = queue.enqueueAndWait<SearchReferenceDescriptor>(`heic-reference-${index}`, {
          type: 'prepare_search_reference', bookId: created.value.bookId,
          mediaKind: 'image', name: 'reference.HEIC', uploadPath, cleanupRoot,
        }, timeout)
        if (index === 0) {
          const descriptor = await result
          try {
            const stored = searchReferenceStore.get(descriptor.reference_id)
            expect(stored.reference.kind).toBe('image')
            if (stored.reference.kind !== 'image') throw new Error('Expected an image reference')
            expect(stored.reference.vector).toHaveLength(512)
            expect(stored.reference.vector.every(Number.isFinite)).toBe(true)
            expect(stored.reference.fingerprints).toEqual([
              { kind: 'sha256', value: createHash('sha256').update(original).digest('hex') },
            ])
            expect(await sharp(stored.preview!).metadata()).toMatchObject({ format: 'png', width: 64, height: 96 })
          } finally {
            searchReferenceStore.release(descriptor.reference_id)
          }
        } else await expect(result).rejects.toThrow()
        await expect(readFile(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(engine.artifacts.list()).toEqual(before)
      const artifact = await engine.artifacts.create('image', 'Legacy HEIC')
      if (!artifact.ok) throw new Error(artifact.error.message)
      const assetId = artifact.value.artifactId
      const written = await engine.files.write(assetId, 'original.heic', original)
      if (!written.ok) throw new Error(written.error.message)
      const assets = engine.artifacts.list()
      const managedReference = await queue.enqueueAndWait<SearchReferenceDescriptor>('managed-heic-reference', {
        type: 'prepare_search_reference', bookId: created.value.bookId,
        mediaKind: 'image', name: 'Legacy HEIC', assetId,
      }, timeout)
      try {
        const stored = searchReferenceStore.get(managedReference.reference_id)
        expect(stored.reference).toMatchObject({
          kind: 'image', fingerprints: [{ kind: 'sha256', value: createHash('sha256').update(original).digest('hex') }],
        })
        expect(await sharp(stored.preview!).metadata()).toMatchObject({ format: 'png', width: 64, height: 96 })
        expect(engine.artifacts.list()).toEqual(assets)
        const read = await engine.files.read(assetId, 'original.heic')
        expect(read.ok && read.value.equals(original)).toBe(true)
      } finally {
        searchReferenceStore.release(managedReference.reference_id)
      }
    } finally {
      await queue.stop()
      await books.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  describe('browser uploads', () => {
    let root: string
    let serverUrl: string
    let browser: Browser
    let page: Page
    let client: Client
    let bookId: string
    let notebookId: string
    let cellId: string
    let assetId: string
    let fixture: Buffer
    let originalAssets: string[]
    const processes: StartedProcess[] = []

    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      return resultValue(await client.callTool({ name, arguments: { book_id: bookId, notebook_id: notebookId, ...args } })) as T
    }

    async function assetIds(): Promise<string[]> {
      const result = await call<{ assets: Array<{ artifact_id: string }> }>('list_assets')
      return result.assets.map(asset => asset.artifact_id).sort()
    }

    async function temporaryFiles(): Promise<string[]> {
      return (await readdir(join(root, 'tmp'))).filter(name => name.startsWith('videobook-search-'))
    }

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'videobook-heic-reference-browser-'))
      await mkdir(join(root, 'tmp'))
      fixture = await readFile(fixturePath)
      serverUrl = `http://127.0.0.1:${await availablePort()}`
      const appUrl = `http://127.0.0.1:${await availablePort()}`
      const server = startProcess(['--import', 'tsx', 'server/src/index.ts'], {
        ...process.env, PORT: new URL(serverUrl).port, TMPDIR: join(root, 'tmp'),
        VIDEOBOOK_MODEL_DOWNLOAD: 'disabled',
        B2_ACCESS_KEY_ID: '', B2_BUCKET: '', B2_ENDPOINT: '', B2_REGION: '', B2_SECRET_ACCESS_KEY: '',
        VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'app-state.json'),
      })
      processes.push(server)
      await waitForHttp(`${serverUrl}/healthz`, server, 200)
      client = new Client({ name: 'heic-reference-browser', version: '1' }, {
        capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
      })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`)))
      bookId = (await call<{ bookId: string }>('create_book', { name: 'heic-reference-browser' })).bookId
      notebookId = (await call<Array<{ id: string }>>('list_notebooks'))[0]!.id
      cellId = (await call<{ id: string }>('create_notebook_cell', { cell: { type: 'image', slot: { row: 0, column: 0 } } })).id
      assetId = (await call<{ assetId: string }>('upload_file', {
        filename: 'source.png', data: (await decodeHeicToPng(fixture)).toString('base64'),
      })).assetId
      const repair = await call<{ jobs: Array<{ jobId: number }> }>('repair_library_search_indexes', { kinds: ['image'] })
      await vi.waitFor(async () => {
        const jobs = await call<Array<{ state: string }>>('list_jobs', { job_ids: repair.jobs.map(job => job.jobId) })
        expect(jobs.map(job => job.state)).toEqual(repair.jobs.map(() => 'done'))
      }, { timeout })
      originalAssets = await assetIds()
      const vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', new URL(appUrl).port, '--strictPort'], {
        ...process.env, VIDEOBOOK_SERVER_URL: serverUrl, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0',
      })
      processes.push(vite)
      await waitForHttp(appUrl, vite, 200)
      browser = await chromium.launch({ headless: true })
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      await page.goto(appUrl)
      await page.locator(`.react-flow__node[data-id="${cellId}"]`).waitFor({ state: 'visible', timeout })
    }, 120_000)

    afterAll(async () => {
      await browser?.close()
      await client?.close()
      for (const process of processes.reverse()) await stopProcess(process)
      if (root) await rm(root, { recursive: true, force: true })
    }, 60_000)

    afterEach(async ({ task }) => {
      if (task.result?.state === 'fail' && page && !page.isClosed()) console.error(await page.locator('body').innerText())
    })

    it.each([
      { surface: 'picker', filename: 'reference.HEIC', release: 'clear' },
      { surface: 'drop', filename: 'reference.heif', release: 'close' },
    ])('prepares $filename through $surface without MIME metadata and releases it on $release', async ({ surface, filename, release }) => {
      await page.locator(`.react-flow__node[data-id="${cellId}"] .cell-node`).click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Choose media' }).click()
      const library = page.getByRole('region', { name: 'Choose image media' })
      await library.getByRole('tab', { name: 'Image reverse' }).click()
      const reference = library.locator('.reverse-search-reference')
      expect(await reference.locator('input[type="file"]').getAttribute('accept')).toContain('.heic,.heif')
      const prepared = page.waitForResponse(response => new URL(response.url()).pathname === '/api/search-references' && response.request().method() === 'POST', { timeout })
      if (surface === 'picker') {
        await reference.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: '', buffer: fixture })
      } else {
        const dataTransfer = await page.evaluateHandle(({ name, bytes }) => {
          const transfer = new DataTransfer()
          transfer.items.add(new File([new Uint8Array(bytes)], name, { type: '' }))
          return transfer
        }, { name: filename, bytes: [...fixture] })
        await reference.dispatchEvent('drop', { dataTransfer })
        await dataTransfer.dispose()
      }
      const response = await prepared
      expect(response.status()).toBe(200)
      const descriptor = await response.json() as SearchReferenceDescriptor
      expect(descriptor.name).toBe(filename)
      expect(descriptor.preview_url).toBe(`/api/search-references/${descriptor.reference_id}/preview`)
      await expect.poll(() => reference.locator('img').evaluate(image => [(image as HTMLImageElement).naturalWidth, (image as HTMLImageElement).naturalHeight]), { timeout }).toEqual([64, 96])
      expect(await reference.locator('img').getAttribute('src')).toBe(descriptor.preview_url)
      const preview = await fetch(`${serverUrl}${descriptor.preview_url}`)
      expect(preview.headers.get('content-type')).toContain('image/png')
      expect(preview.headers.get('cache-control')).toBe('no-store')
      const pixels = await sharp(Buffer.from(await preview.arrayBuffer())).removeAlpha().raw().toBuffer()
      expect(pixels[0]).toBeGreaterThan(240)
      expect(pixels[2]).toBeLessThan(15)
      expect(pixels.at(-1)).toBeGreaterThan(240)
      await expect.poll(() => library.locator('.media-library-results').getAttribute('aria-busy'), { timeout }).toBe('false')
      expect(await library.locator('.media-library-asset').first().locator('img').getAttribute('src')).toContain(`/${assetId}/`)
      expect(await assetIds()).toEqual(originalAssets)
      expect(await temporaryFiles()).toEqual([])
      if (release === 'clear') {
        await library.getByLabel('Clear search reference').click()
        await expect.poll(() => reference.locator('img').count(), { timeout }).toBe(0)
        await expect.poll(async () => (await fetch(`${serverUrl}${descriptor.preview_url}`)).status, { timeout }).toBe(404)
      }
      await library.getByRole('tab', { name: 'Image reverse' }).press('Escape')
      await library.waitFor({ state: 'hidden' })
      await expect.poll(async () => (await fetch(`${serverUrl}${descriptor.preview_url}`)).status, { timeout }).toBe(404)
      await expect(call('search_library_assets', { kinds: ['image'], reference_id: descriptor.reference_id })).rejects.toThrow('expired or was released')
    }, 120_000)

    it('rejects corrupt HEIC and cleans the upload without adding library assets', async () => {
      const query = new URLSearchParams({ filename: 'broken.heic', bookId, kind: 'image' })
      const response = await fetch(`${serverUrl}/api/search-references?${query}`, { method: 'POST', body: 'broken HEIC' })
      expect(response.status).toBe(400)
      expect(await temporaryFiles()).toEqual([])
      expect(await assetIds()).toEqual(originalAssets)
    }, timeout)
  })
})

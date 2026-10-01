import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEngine, type Engine } from 'videobook-engine'
import { assetTagDefs } from '../../server/src/tools/asset-tags.js'
import { assetTagSummary, type AssetTagSummary } from '../../server/src/asset-tags.js'
import type { TagEdit } from '../../src/videobook/asset-tag-editing.js'

const MCP_ROUNDTRIP_MS = 15_000

type TagHarness = {
  setRaw: (tags: AssetTagSummary) => void
  setTarget: (target: { bookId: string; assetId: string }) => void
  controller: {
    addTag: (edit: TagEdit) => Promise<void>
    busy: boolean
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('asset tag editor with a real engine', () => {
  let root: string
  let engine: Engine
  let assetId: string
  let sourceHash: string
  let server: Server
  let browser: Browser
  let page: Page
  let responseGate: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null

  beforeEach(async () => {
    responseGate = null
    root = await mkdtemp(join(tmpdir(), 'tag-editor-browser-'))
    engine = createEngine({ durableWrites: false, rootDir: root, initialBookName: 'Tag editor browser' })
    await engine.ready
    const asset = await engine.artifacts.create({ kind: 'image' })
    if (!asset.ok) throw new Error(asset.error.message)
    assetId = asset.value.artifactId
    expect((await engine.files.write(assetId, 'original.png', 'browser fixture')).ok).toBe(true)
    const files = await engine.files.manifest(assetId)
    if (!files.ok) throw new Error(files.error.message)
    sourceHash = files.value.files[0]!.objectHash
    const target = { bookId: engine.book.get().bookId, assetId }
    const client = `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useAssetTags} from './src/videobook/use-asset-tags.ts';
      import {parseAssetTags} from './src/videobook/asset-tags.ts';
      import {AssetTagEditor} from './src/components/videobook/AssetTagEditor.tsx';
      const target = ${JSON.stringify(target)};
      async function call(tool, args) {
        const response = await fetch('/tool', {method: 'POST', body: JSON.stringify({tool, args})});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return data;
      }
      function Harness() {
        const [raw, setRaw] = useState(${JSON.stringify(summary())});
        const [activeTarget, setTarget] = useState(target);
        const controller = useAssetTags({call, target: activeTarget, tags: parseAssetTags(raw)});
        window.tagHarness = {controller, setRaw, setTarget};
        return React.createElement(AssetTagEditor, {
          ...controller, onAdd: controller.addTag, onRemove: controller.removeTag,
          onRestore: controller.restoreTag, onQueryChange: controller.loadSuggestions,
        });
      }
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
    `
    const bundle = await build({
      stdin: { contents: client, resolveDir: process.cwd(), sourcefile: 'tag-harness.js', loader: 'js' },
      bundle: true, write: false, platform: 'browser', format: 'iife',
      tsconfig: 'tsconfig.app.json',
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    })
    const defs = assetTagDefs(engine)
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/app.js') {
          response.setHeader('content-type', 'text/javascript')
          response.end(bundle.outputFiles[0]!.text)
          return
        }
        if (request.url === '/tool') {
          let body = ''
          for await (const chunk of request) body += String(chunk)
          const data = JSON.parse(body) as { tool: string; args: Record<string, unknown> }
          const def = defs.find((entry) => entry.name === data.tool)
          if (!def) throw new Error('Unknown tool')
          const gate = data.tool === 'add_asset_tag' ? responseGate : null
          if (gate) responseGate = null
          const result = await def.handler(z.object(def.schema).parse(data.args))
          if (gate) { gate.started.resolve(); await gate.release.promise }
          const content = result.content.find((entry) => entry.type === 'text')
          if (!content || content.type !== 'text') throw new Error('Missing result')
          if (result.isError) throw new Error(content.text)
          response.setHeader('content-type', 'application/json')
          response.end(content.text)
          return
        }
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><div id="root"></div><script src="/app.js"></script>')
      } catch (error) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByLabel('Add a tag').waitFor()
  })

  afterEach(async () => {
    responseGate?.release.resolve()
    await browser?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    engine?.close()
    await rm(root, { recursive: true, force: true })
  })

  function summary() {
    const result = engine.tags.read(assetId)
    if (!result.ok) throw new Error(result.error.message)
    return assetTagSummary(result.value)
  }

  async function refresh() {
    await page.evaluate((raw) => {
      (window as unknown as { tagHarness: TagHarness }).tagHarness.setRaw(raw)
    }, summary())
  }

  async function settled() {
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { tagHarness: TagHarness }).tagHarness.controller.busy), { timeout: MCP_ROUNDTRIP_MS }).toBe(false)
  }

  async function automatic(label: string) {
    expect((await engine.tags.automatic.replace({
      artifactId: assetId, sourceHash, generator: 'browser-test', extractorVersion: 'test',
      tags: [{ facet: 'places', label }],
    })).ok).toBe(true)
    await refresh()
  }

  it('accepts plain tags and subsequent automatic and external updates', async () => {
    expect(await page.getByRole('combobox').count()).toBe(1)
    expect(await page.locator('select').count()).toBe(0)
    const field = page.getByLabel('Add a tag')
    await field.fill('closeup')
    await field.press('Enter')
    await settled()
    expect(summary().effective).toEqual([expect.objectContaining({ facet: 'editing', key: 'close-up' })])
    expect(await field.evaluate((node) => document.activeElement === node)).toBe(true)
    await automatic('kitchen')
    await expect.poll(() => page.getByRole('button', { name: 'Remove tag kitchen (From analysis)', exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Remove tag kitchen (From analysis)', exact: true }).click()
    await settled()
    await page.getByRole('button', { name: 'Restore tag kitchen', exact: true }).click()
    await settled()
    await automatic('street')
    await expect.poll(() => page.getByRole('button', { name: 'Remove tag street (From analysis)', exact: true }).count()).toBe(1)
    expect((await engine.tags.remove(assetId, { facet: 'editing', label: 'close-up' })).ok).toBe(true)
    await refresh()
    await expect.poll(() => page.getByRole('button', { name: 'Remove tag close-up (Added by you)', exact: true }).count()).toBe(0)
  })

  it('keeps background changes during a delayed reply and rolls back only the failing queued edit', async () => {
    expect((await engine.tags.addMany(assetId, Array.from({ length: 99 }, (_, index) => ({
      facet: 'custom' as const, label: `existing ${index}`,
    })))).ok).toBe(true)
    await refresh()
    await expect.poll(() => page.getByRole('button', { name: /Remove tag existing/ }).count()).toBe(99)
    const gate = { started: deferred(), release: deferred() }
    responseGate = gate
    await page.evaluate(() => {
      const controller = (window as unknown as { tagHarness: TagHarness }).tagHarness.controller
      void controller.addTag({ label: 'keep' })
      void controller.addTag({ label: 'overflow' })
    })
    await gate.started.promise
    try {
      await automatic('kitchen')
      await expect.poll(() => page.getByRole('button', { name: 'Remove tag kitchen (From analysis)', exact: true }).count()).toBe(1)
    } finally { gate.release.resolve() }
    await settled()
    expect(await page.getByRole('button', { name: 'Remove tag keep (Added by you)', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Remove tag overflow (Added by you)', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Remove tag kitchen (From analysis)', exact: true }).count()).toBe(1)
    expect(await page.getByText(/the limit is 100/).count()).toBe(1)
    await automatic('street')
    await expect.poll(() => page.getByRole('button', { name: 'Remove tag street (From analysis)', exact: true }).count()).toBe(1)
  })

  it('keeps a delayed reply on its original asset when the inspector switches', async () => {
    const created = await engine.artifacts.create({ kind: 'image' })
    if (!created.ok) throw new Error(created.error.message)
    const otherId = created.value.artifactId
    const otherState = engine.tags.read(otherId)
    if (!otherState.ok) throw new Error(otherState.error.message)
    const gate = { started: deferred(), release: deferred() }
    responseGate = gate
    await page.evaluate(() => {
      void (window as unknown as { tagHarness: TagHarness }).tagHarness.controller.addTag({ label: 'first asset' })
    })
    await gate.started.promise
    try {
      await page.evaluate(({ target, raw }) => {
        const harness = (window as unknown as { tagHarness: TagHarness }).tagHarness
        harness.setTarget(target)
        harness.setRaw(raw)
      }, { target: { bookId: engine.book.get().bookId, assetId: otherId }, raw: assetTagSummary(otherState.value) })
      await expect.poll(() => page.getByRole('button', { name: 'Remove tag first asset (Added by you)', exact: true }).count()).toBe(0)
    } finally { gate.release.resolve() }
    await page.evaluate(async () => {
      await (window as unknown as { tagHarness: TagHarness }).tagHarness.controller.addTag({ label: 'second asset' })
    })
    await settled()
    expect(await page.getByRole('button', { name: 'Remove tag first asset (Added by you)', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Remove tag second asset (Added by you)', exact: true }).count()).toBe(1)
    expect(summary().effective.map((tag) => tag.key)).toEqual(['first asset'])
    const second = engine.tags.read(otherId)
    if (!second.ok) throw new Error(second.error.message)
    expect(second.value.effective.map((tag) => tag.key)).toEqual(['second asset'])
  })
})

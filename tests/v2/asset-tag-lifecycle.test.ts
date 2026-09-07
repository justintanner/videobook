import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Engine } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { assetTagDefs } from '../../server/src/tools/asset-tags.js'
import { tagBackfillDefs } from '../../server/src/tools/tag-backfill.js'
import { listAssetsDef } from '../../server/src/tools/list-assets.js'
import { runAssetTagging } from '../../server/src/jobs/tag-asset.js'
import { copyLibraryAsset } from '../../server/src/media-library.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

/**
 * What has to stay true about tags as assets live their lives.
 *
 * The individual pieces are covered where they are implemented; this file is
 * about the seams between them — an edit made while a job is in flight, a
 * fence that must reject a result for content that no longer exists, a copy
 * that has to stop being the original. Everything runs against real books and
 * the real queue, with analysis supplied as cached fixtures so no provider is
 * called.
 */

const ANALYSIS_FILENAME = '.original.analysis.json'

const KITCHEN_ANALYSIS = {
  summary: 'A cook works at a counter.',
  setting: 'A domestic kitchen, interior',
  subjects: ['one person'],
  tags: ['close up'],
  actions: [],
  scenes: [],
}

const STREET_ANALYSIS = {
  summary: 'Traffic passes at night.',
  setting: 'A street, exterior, night',
  subjects: [],
  tags: ['wide shot'],
  actions: [],
  scenes: [],
}

describe('asset tag lifecycle', () => {
  let rootDir: string
  let books: BookManager
  let bookId: string
  let engine: Engine
  let defs: Map<string, ToolDef>

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-tag-lifecycle-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const created = await books.create('lifecycle')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const managed = books.get(bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    engine = managed.value.engine
    defs = new Map([
      ...assetTagDefs(scopedBookEngine),
      ...tagBackfillDefs(scopedBookEngine),
      listAssetsDef(scopedBookEngine),
    ].map((def) => [def.name, def]))
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  async function invoke(
    name: string,
    args: Record<string, unknown>,
    targetEngine: Engine = engine,
    targetBookId: string = bookId,
  ) {
    const def = defs.get(name)
    if (!def) throw new Error(`Missing tool ${name}`)
    return await withBookContext(
      { bookId: targetBookId, engine: targetEngine },
      () => def.handler({ book_id: targetBookId, ...args }),
    )
  }

  function parse(result: { content: Array<{ text: string }>; isError?: true }) {
    expect(result.isError, result.content[0]?.text).toBeUndefined()
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>
  }

  async function makeAsset(
    kind: 'video' | 'image' | 'audio',
    filename: string,
    bytes: string,
    analysis?: unknown,
    target: Engine = engine,
  ): Promise<string> {
    const created = await target.artifacts.create({ kind })
    if (!created.ok) throw new Error(created.error.message)
    const assetId = created.value.artifactId
    const written = await target.files.write(assetId, filename, Buffer.from(bytes))
    if (!written.ok) throw new Error(written.error.message)
    if (analysis !== undefined) {
      const cached = await target.files.write(
        assetId,
        ANALYSIS_FILENAME,
        JSON.stringify(analysis),
      )
      if (!cached.ok) throw new Error(cached.error.message)
    }
    return assetId
  }

  function tagsOf(assetId: string, target: Engine = engine): string[] {
    const state = target.tags.read(assetId)
    if (!state.ok) throw new Error(state.error.message)
    return state.value.effective.map((tag) => `${tag.facet}/${tag.key}`).sort()
  }

  async function tag(assetId: string, force = false) {
    return await runAssetTagging(engine, {
      type: 'tag_asset',
      bookId,
      assetId,
      ...(force ? { force: true } : {}),
    })
  }

  it('tags an asset that was never placed on a timeline', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a', KITCHEN_ANALYSIS)
    // No notebook, no cell, no slot: the asset exists only in the Library.
    expect(engine.notebooks.list().every((notebook) =>
      notebook.cells.every((cell) => cell.outputArtifactId !== assetId))).toBe(true)

    expect((await tag(assetId)).outcome).toBe('tagged')
    expect(tagsOf(assetId)).toContain('places/kitchen')
  })

  it('deduplicates a case and accent variant of a tag someone already added', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a')
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Café Scene',
    })
    const second = parse(await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      // Same text, different case and a decomposed accent.
      label: 'café SCENE',
    }))
    const tags = (second.tags as { effective: Array<{ key: string }> }).effective
    expect(tags).toHaveLength(1)
    expect(tags[0]?.key).toBe('café scene')
  })

  it('keeps a dismissal through forced re-analysis and keeps manual tags too', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a', KITCHEN_ANALYSIS)
    expect((await tag(assetId)).outcome).toBe('tagged')
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Keeper',
    })
    await invoke('remove_asset_tag', {
      asset_id: assetId,
      facet: 'places',
      label: 'kitchen',
    })

    expect((await tag(assetId, true)).outcome).toBe('tagged')
    expect(tagsOf(assetId)).not.toContain('places/kitchen')
    expect(tagsOf(assetId)).toContain('custom/keeper')

    // Restoring lets the analysis surface it again.
    await invoke('restore_asset_tag', {
      asset_id: assetId,
      facet: 'places',
      label: 'kitchen',
    })
    expect(tagsOf(assetId)).toContain('places/kitchen')
  })

  it('retains a manual tag added while a tagging run is in flight', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a', KITCHEN_ANALYSIS)
    // Both writes race the same artifact; manual intent must survive whichever
    // order the engine serializes them in.
    const [, manual] = await Promise.all([
      tag(assetId),
      invoke('add_asset_tag', {
        asset_id: assetId,
        facet: 'custom',
        label: 'Mid-flight',
      }),
    ])
    expect(manual.isError).toBeUndefined()
    expect(tagsOf(assetId)).toContain('custom/mid-flight')
    expect(tagsOf(assetId)).toContain('places/kitchen')
  })

  it('drops automatic tags when the content they described is replaced', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'first', KITCHEN_ANALYSIS)
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Keeper',
    })
    expect((await tag(assetId)).outcome).toBe('tagged')
    expect(tagsOf(assetId)).toContain('places/kitchen')

    const replaced = await engine.files.write(
      assetId,
      'original.mp4',
      Buffer.from('second'),
    )
    expect(replaced.ok).toBe(true)
    // The claim was about bytes the asset no longer has.
    expect(tagsOf(assetId)).toEqual(['custom/keeper'])

    // A result computed for the old content cannot publish against the new.
    const stale = await engine.tags.automatic.replace({
      artifactId: assetId,
      sourceHash: 'a'.repeat(64),
      generator: 'test',
      extractorVersion: 'editorial-tags-v1',
      tags: [{ facet: 'places', label: 'Kitchen' }],
    })
    expect(stale.ok).toBe(true)
    expect(tagsOf(assetId)).toEqual(['custom/keeper'])
  })

  it('leaves assets usable when no provider is configured', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a')
    const result = await tag(assetId)
    // No cached analysis and no key: an explicit state, not a failure.
    expect(['analysis_unavailable', 'no_evidence']).toContain(result.outcome)
    const artifact = engine.artifacts.get(assetId)
    expect(artifact.ok).toBe(true)

    // Manual tagging still works, which is the promise that matters here.
    const manual = parse(await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'By hand',
    }))
    expect((manual.tags as { effective: unknown[] }).effective).toHaveLength(1)
  })

  it('does not queue index work for a tag edit', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a', KITCHEN_ANALYSIS)
    await tag(assetId)
    const before = engine.jobs.queue.list({ type: 'semantic_index' }).length

    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Keeper',
    })
    await invoke('remove_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Keeper',
    })

    // Editing a tag changes text, not pixels: rebuilding visual or audio
    // embeddings for it would be pure waste.
    expect(engine.jobs.queue.list({ type: 'semantic_index' }).length).toBe(before)
  })

  it('keeps a copy independent of the asset it came from', async () => {
    const other = await books.create('lifecycle-target')
    if (!other.ok) throw new Error(other.error.message)
    const targetBook = books.get(other.value.bookId)
    if (!targetBook.ok) throw new Error(targetBook.error.message)

    const assetId = await makeAsset('image', 'original.png', 'a')
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'places',
      label: 'Kitchen',
    })
    const copied = await copyLibraryAsset(books, {
      sourceBookId: bookId,
      sourceArtifactId: assetId,
      targetBookId: other.value.bookId,
    })
    expect(tagsOf(copied.targetArtifactId, targetBook.value.engine))
      .toEqual(['places/kitchen'])

    await invoke(
      'add_asset_tag',
      { asset_id: copied.targetArtifactId, facet: 'custom', label: 'Copy only' },
      targetBook.value.engine,
      other.value.bookId,
    )
    expect(tagsOf(assetId)).toEqual(['places/kitchen'])
    expect(tagsOf(copied.targetArtifactId, targetBook.value.engine)).toEqual([
      'custom/copy only',
      'places/kitchen',
    ])
  })

  it('lets a tagged asset be deleted and leaves no tags behind', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a', KITCHEN_ANALYSIS)
    await tag(assetId)
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Keeper',
    })

    const deleted = await engine.artifacts.delete(assetId)
    expect(deleted.ok).toBe(true)
    expect(engine.artifacts.get(assetId).ok).toBe(false)
    // Tag rows follow the artifact rather than outliving it as orphans.
    const orphaned = engine.tags.query({
      all: [{ facet: 'custom', label: 'Keeper' }],
    })
    expect(orphaned.ok && orphaned.value.artifacts).toEqual([])
  })

  it('counts every match before paging a filtered list', async () => {
    const kitchens: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const assetId = await makeAsset(
        'video',
        'original.mp4',
        `kitchen-${index}`,
        KITCHEN_ANALYSIS,
      )
      await tag(assetId)
      kitchens.push(assetId)
    }
    const street = await makeAsset('video', 'original.mp4', 'street', STREET_ANALYSIS)
    await tag(street)

    const page = parse(await invoke('list_assets', {
      tags_all: [{ facet: 'places', label: 'kitchen' }],
      limit: 2,
      offset: 0,
    })) as unknown as {
      assets: Array<{ artifact_id: string }>
      page: { total: number; hasMore: boolean }
    }
    expect(page.assets).toHaveLength(2)
    // The total describes the filter, not the page or the book.
    expect(page.page.total).toBe(3)
    expect(page.page.hasMore).toBe(true)
    expect(page.assets.every((asset) => kitchens.includes(asset.artifact_id)))
      .toBe(true)

    const rest = parse(await invoke('list_assets', {
      tags_all: [{ facet: 'places', label: 'kitchen' }],
      limit: 2,
      offset: 2,
    })) as unknown as {
      assets: Array<{ artifact_id: string }>
      page: { hasMore: boolean }
    }
    expect(rest.assets).toHaveLength(1)
    expect(rest.page.hasMore).toBe(false)
    expect(rest.assets[0]?.artifact_id).not.toBe(street)
  })

  it('reads tags as an earlier revision recorded them', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a')
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'First',
    })
    const revision = engine.head
    await invoke('add_asset_tag', {
      asset_id: assetId,
      facet: 'custom',
      label: 'Second',
    })
    expect(tagsOf(assetId)).toEqual(['custom/first', 'custom/second'])

    // Tags are versioned with everything else the book records, so an earlier
    // revision still reads the way it did at the time.
    const historical = engine.tags.readAtRevision(assetId, revision)
    expect(historical.ok).toBe(true)
    expect(historical.ok && historical.value.effective.map((tag) => tag.key))
      .toEqual(['first'])
  })

  it('retries one asset after analysis becomes available', async () => {
    const assetId = await makeAsset('video', 'original.mp4', 'a')
    const first = parse(await invoke('retag_asset', {
      asset_id: assetId,
      cached_only: true,
    }))
    expect(first.outcome).toBe('no_evidence')

    // The analysis lands later, exactly as a completed job would leave it.
    const cached = await engine.files.write(
      assetId,
      ANALYSIS_FILENAME,
      JSON.stringify(KITCHEN_ANALYSIS),
    )
    expect(cached.ok).toBe(true)

    const second = parse(await invoke('retag_asset', { asset_id: assetId }))
    expect(second.outcome).toBe('tagged')
    expect(tagsOf(assetId)).toContain('places/kitchen')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
  NotebookEdge,
} from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import {
  scopedBookEngine,
  withBookContext,
} from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  planNotebookArrangement,
  revealNotebookArrangement,
} from '../../src/videobook/notebook-auto-arrange.js'
import {
  notebookLaneFamily,
  notebookLaneFamilyLabel,
  NOTEBOOK_LANE_FAMILY_ORDER,
  summarizeNotebookLaneRows,
} from '../../src/videobook/notebook-lane-policy.js'
import { arrangeGoalNotebook } from '../../server/src/notebook-goal-layout.js'

function cell(
  id: string,
  row: number,
  column: number,
  type: NotebookCell['type'] = 'prompt',
): NotebookCell {
  return { id, type, label: id, prompt: id, slot: { row, column } }
}

function edge(source: string, target: string, ordinal = 0): NotebookEdge {
  return {
    id: `${source}-${target}-${ordinal}`,
    source,
    target,
    targetInput: `input-${ordinal}`,
  }
}

function document(
  cells: NotebookCell[],
  edges: NotebookEdge[] = [],
): NotebookDocument {
  return {
    id: 'notebook',
    name: 'Auto arrange',
    cells,
    edges,
    createdAt: '2026-08-18T00:00:00.000Z',
  }
}

function assignmentMap(
  value: ReturnType<typeof planNotebookArrangement>,
): Map<string, { row: number; column: number }> {
  expect(value.ok, value.ok ? undefined : value.message).toBe(true)
  if (!value.ok) return new Map()
  return new Map(value.slots.map(({ id, row, column }) => [
    id,
    { row, column },
  ]))
}

function applyAssignments(
  source: NotebookDocument,
  assignments: ReadonlyMap<string, { row: number; column: number }>,
): NotebookDocument {
  return {
    ...source,
    cells: source.cells.map((item) => ({
      ...item,
      slot: assignments.get(item.id) ?? item.slot,
    })),
  }
}

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function familyOf(type: NotebookCellType) {
  return notebookLaneFamily(type)
}

describe('notebook family-lane auto-arrange', () => {
  it('groups goal references and generators above image and video outputs with the timeline last', () => {
    const source = document([
      cell('reference', 0, 0, 'image'), cell('goal', 0, 1, 'goal'),
      cell('gen-image', 0, 2, 'generate_image'), cell('image-output', 0, 3, 'image'),
      cell('timeline', 1, 0, 'timeline'), cell('gen-video', 2, 3, 'generate_video'), cell('video-output', 3, 3, 'video'),
    ], [edge('reference', 'gen-image'), edge('gen-image', 'image-output'), edge('image-output', 'gen-video'), edge('gen-video', 'video-output')])
    const before = structuredClone(source)
    const slots = assignmentMap(planNotebookArrangement(source))
    expect(slots.get('reference')).toEqual({ row: 0, column: 0 })
    expect(slots.get('goal')).toEqual({ row: 0, column: 1 })
    expect(slots.get('gen-image')).toEqual({ row: 0, column: 2 })
    expect(slots.get('gen-video')).toEqual({ row: 0, column: 3 })
    expect(slots.get('image-output')).toEqual({ row: 1, column: 0 })
    expect(slots.get('video-output')).toEqual({ row: 2, column: 0 })
    expect(slots.get('timeline')).toEqual({ row: 3, column: 0 })
    const arranged = applyAssignments(source, slots)
    expect(arrangeGoalNotebook(source)).toEqual(arranged)
    expect(arrangeGoalNotebook(arranged)).toEqual(arranged)
    expect(source).toEqual(before)
    expect(arranged.edges).toEqual(before.edges)
  })

  it('keeps generated character references on top and gives overflow groups their own rows', () => {
    const source = document([
      { ...cell('reference', 3, 0, 'image'), inputs: { producerCellId: 'old-generator' } },
      { ...cell('goal', 4, 0, 'goal'), inputs: { characters: [{ cellId: 'reference' }] } },
      ...Array.from({ length: 9 }, (_, index) => cell(`gen-${index}`, 5, index % 8, 'generate_image')),
      ...Array.from({ length: 9 }, (_, index) => ({ ...cell(`img-${index}`, 7, index % 8, 'image'), inputs: { producerCellId: `gen-${index}` } })),
      cell('video', 8, 0, 'video'), cell('timeline', 0, 0, 'timeline'), cell('timeline-2', 1, 0, 'timeline'),
    ])
    const slots = assignmentMap(planNotebookArrangement(source))
    expect(slots.get('reference')).toEqual({ row: 0, column: 0 })
    expect(slots.get('gen-8')).toEqual({ row: 1, column: 2 })
    expect(slots.get('img-0')).toEqual({ row: 2, column: 0 })
    expect(slots.get('img-8')).toEqual({ row: 3, column: 0 })
    expect(slots.get('video')).toEqual({ row: 4, column: 0 })
    expect(slots.get('timeline')).toEqual({ row: 5, column: 0 })
    expect(slots.get('timeline-2')).toEqual({ row: 6, column: 0 })
  })

  it('rejects a goal stage whose separate rows exceed capacity before allocating its outputs', () => {
    const source = document([cell('goal', 0, 0, 'goal'), ...Array.from({ length: 61 }, (_, index) => cell(`timeline-${index}`, index + 1, 0, 'timeline'))])
    expect(() => arrangeGoalNotebook(source, { generators: 8, images: 8, videos: 8 })).toThrow('65 rows')
    expect(planNotebookArrangement(source).ok).toBe(true)
  })

  it('keeps Timeline rows intact while arranging every other family around them', () => {
    const source = document([
      cell('timeline', 1, 0, 'timeline'),
      ...Array.from({ length: 9 }, (_, index) => cell(`image-${index}`, 10 + index, 3, 'image')),
      cell('video', 25, 4, 'video'),
      cell('audio', 27, 6, 'audio'),
    ])
    const slots = assignmentMap(planNotebookArrangement(source))
    expect(slots.get('timeline')).toEqual({ row: 1, column: 0 })
    expect([...slots].filter(([id]) => id !== 'timeline').every(([, slot]) => slot.row !== 1)).toBe(true)
    expect(slots.get('image-8')).toEqual({ row: 2, column: 0 })
    expect(slots.get('video')).toEqual({ row: 3, column: 0 })
    const arranged = applyAssignments(source, slots)
    expect(planNotebookArrangement(arranged)).toEqual(planNotebookArrangement(source))
  })

  it('packs Images, Gen, and Videos into contiguous a/b/c rows', () => {
    const source = document([
      cell('vid-b', 8, 11, 'video'),
      cell('img-b', 4, 10, 'image'),
      cell('prompt', 2, 3),
      cell('img-a', 1, 9, 'image'),
      cell('vid-a', 7, 1, 'video'),
      cell('gen', 12, 0, 'generate_video'),
    ])
    const planned = planNotebookArrangement(source)
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(3)
    expect(slots.get('img-a')).toEqual({ row: 0, column: 0 })
    expect(slots.get('img-b')).toEqual({ row: 0, column: 1 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 0 })
    expect(slots.get('gen')).toEqual({ row: 1, column: 1 })
    expect(slots.get('vid-a')).toEqual({ row: 2, column: 0 })
    expect(slots.get('vid-b')).toEqual({ row: 2, column: 1 })
    const arranged = applyAssignments(source, slots)
    expect(summarizeNotebookLaneRows(arranged.cells, 3).map((row) => row.caption))
      .toEqual(['Images', 'Gen', 'Videos'])
  })

  it('classifies every generate_* type plus prompt, media, edit, audio, and work', () => {
    const source = document([
      cell('image', 9, 1, 'image'),
      cell('prompt', 8, 2, 'prompt'),
      cell('generate_audio', 7, 3, 'generate_audio'),
      cell('generate_image', 6, 4, 'generate_image'),
      cell('generate_video', 5, 5, 'generate_video'),
      cell('video', 4, 6, 'video'),
      cell('concat', 3, 7, 'concat'),
      cell('splice', 2, 0, 'splice'),
      cell('split_video', 1, 1, 'split_video'),
      cell('audio', 10, 2, 'audio'),
      cell('extract_audio', 11, 3, 'extract_audio'),
      cell('analyze', 12, 4, 'analyze'),
      cell('analysis', 13, 5, 'analysis'),
      cell('character', 14, 6, 'character'),
    ])
    const slots = assignmentMap(planNotebookArrangement(source))

    expect(familyOf('generate_audio')).toBe('gen')
    expect(familyOf('generate_image')).toBe('gen')
    expect(familyOf('generate_video')).toBe('gen')
    expect(NOTEBOOK_LANE_FAMILY_ORDER.map(notebookLaneFamilyLabel)).toEqual([
      'Images',
      'Gen',
      'Videos',
      'Audio',
      'Work',
    ])
    expect(slots.get('image')).toEqual({ row: 0, column: 0 })
    expect(slots.get('generate_video')).toEqual({ row: 1, column: 0 })
    expect(slots.get('generate_image')).toEqual({ row: 1, column: 1 })
    expect(slots.get('generate_audio')).toEqual({ row: 1, column: 2 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 3 })
    expect(slots.get('split_video')).toEqual({ row: 2, column: 0 })
    expect(slots.get('splice')).toEqual({ row: 2, column: 1 })
    expect(slots.get('concat')).toEqual({ row: 2, column: 2 })
    expect(slots.get('video')).toEqual({ row: 2, column: 3 })
    expect(slots.get('audio')).toEqual({ row: 3, column: 0 })
    expect(slots.get('extract_audio')).toEqual({ row: 3, column: 1 })
    expect(slots.get('analyze')).toEqual({ row: 4, column: 0 })
    expect(slots.get('analysis')).toEqual({ row: 4, column: 1 })
    expect(slots.get('character')).toEqual({ row: 4, column: 2 })
  })

  it('keeps leftover family columns empty so the next family starts on a new row', () => {
    const source = document([
      cell('img', 5, 5, 'image'),
      cell('prompt', 0, 0),
      cell('vid', 9, 9, 'video'),
    ])
    const slots = assignmentMap(planNotebookArrangement(source))

    expect(slots.get('img')).toEqual({ row: 0, column: 0 })
    expect(slots.get('prompt')).toEqual({ row: 1, column: 0 })
    expect(slots.get('vid')).toEqual({ row: 2, column: 0 })
    expect([...slots.values()].some((slot) =>
      slot.row === 0 && slot.column > 0)).toBe(false)
  })

  it('is idempotent after the first arrange', () => {
    const source = document([
      cell('img', 8, 1, 'image'),
      cell('left', 4, 6),
      cell('right', 2, 3, 'generate_image'),
      cell('vid', 1, 7, 'video'),
    ])
    const first = planNotebookArrangement(source)
    const slots = assignmentMap(first)
    const arranged = applyAssignments(source, slots)
    expect(planNotebookArrangement(arranged)).toEqual(first)
  })

  it('keeps nine-plus overflow inside the same family instead of a shared pool', () => {
    const images = Array.from({ length: 9 }, (_, index) =>
      cell(
        `img-${String(index).padStart(2, '0')}`,
        index < 8 ? 10 : 11,
        index % 8,
        'image',
      ))
    const gens = [
      cell('prompt', 0, 0),
      cell('gen', 0, 1, 'generate_video'),
    ]
    const videos = Array.from({ length: 9 }, (_, index) =>
      cell(
        `vid-${String(index).padStart(2, '0')}`,
        index < 8 ? 6 : 7,
        index % 8,
        'video',
      ))
    const planned = planNotebookArrangement(document([
      ...images,
      ...gens,
      ...videos,
    ]))
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(5)
    for (let index = 0; index < 8; index += 1) {
      expect(slots.get(images[index]!.id)).toEqual({ row: 0, column: index })
    }
    expect(slots.get('img-08')).toEqual({ row: 1, column: 0 })
    expect(slots.get('prompt')).toEqual({ row: 2, column: 0 })
    expect(slots.get('gen')).toEqual({ row: 2, column: 1 })
    for (let index = 0; index < 8; index += 1) {
      expect(slots.get(videos[index]!.id)).toEqual({ row: 3, column: index })
    }
    expect(slots.get('vid-08')).toEqual({ row: 4, column: 0 })
    const arranged = applyAssignments(document([
      ...images,
      ...gens,
      ...videos,
    ]), slots)
    expect(summarizeNotebookLaneRows(arranged.cells, 5).map((row) => ({
      caption: row.caption,
      continuation: row.continuation,
    }))).toEqual([
      { caption: 'Images', continuation: false },
      { caption: 'Images', continuation: true },
      { caption: 'Gen', continuation: false },
      { caption: 'Videos', continuation: false },
      { caption: 'Videos', continuation: true },
    ])
  })

  it('skips absent families so a gen-only book starts on row 0', () => {
    const others = Array.from({ length: 10 }, (_, index) =>
      cell(
        `cell-${String(index).padStart(2, '0')}`,
        index < 8 ? 6 : 7,
        index % 8,
      ))
    const planned = planNotebookArrangement(document(others))
    const slots = assignmentMap(planned)

    expect(planned.ok && planned.rowCount).toBe(2)
    for (let index = 0; index < 8; index += 1) {
      expect(slots.get(others[index]!.id)).toEqual({ row: 0, column: index })
    }
    expect(slots.get('cell-08')).toEqual({ row: 1, column: 0 })
    expect(slots.get('cell-09')).toEqual({ row: 1, column: 1 })
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 64 && slot.column >= 0 && slot.column <= 7))
      .toBe(true)
  })

  it('orders cells by current reading order, not source array order', () => {
    const reversed = document([
      cell('img-b', 4, 3, 'image'),
      cell('img-a', 4, 1, 'image'),
      cell('img-c', 5, 0, 'image'),
    ])
    const shuffled = document([
      cell('img-c', 5, 0, 'image'),
      cell('img-a', 4, 1, 'image'),
      cell('img-b', 4, 3, 'image'),
    ])
    expect(planNotebookArrangement(reversed)).toEqual(planNotebookArrangement(shuffled))
    const slots = assignmentMap(planNotebookArrangement(reversed))
    expect(slots.get('img-a')).toEqual({ row: 0, column: 0 })
    expect(slots.get('img-b')).toEqual({ row: 0, column: 1 })
    expect(slots.get('img-c')).toEqual({ row: 0, column: 2 })
  })

  it('ignores edges including cycles and missing endpoints', () => {
    const cyclic = planNotebookArrangement(document(
      [cell('img', 9, 9, 'image'), cell('vid', 1, 1, 'video')],
      [edge('img', 'vid'), edge('vid', 'img')],
    ))
    const slots = assignmentMap(cyclic)
    expect(slots.get('img')).toEqual({ row: 0, column: 0 })
    expect(slots.get('vid')).toEqual({ row: 1, column: 0 })

    const missing = planNotebookArrangement(document(
      [cell('a', 0, 0, 'image')],
      [edge('a', 'missing')],
    ))
    expect(assignmentMap(missing).get('a')).toEqual({ row: 0, column: 0 })
  })

  it('rejects duplicate cell ids', () => {
    const duplicate = planNotebookArrangement(document(
      [cell('a', 0, 0), cell('a', 0, 1)],
    ))
    expect(duplicate).toMatchObject({ ok: false, code: 'invalid-edge' })
    expect(!duplicate.ok && duplicate.message).toContain('duplicate cell IDs')
  })

  it('lets a homogeneous book use all 512 slots', () => {
    const full = Array.from({ length: 512 }, (_, index) =>
      cell(
        `img-${String(index).padStart(3, '0')}`,
        63 - Math.floor(index / 8),
        7 - index % 8,
        'image',
      ))
    const planned = planNotebookArrangement(document(full))
    const slots = assignmentMap(planned)
    const keys = new Set([...slots.values()].map((slot) => `${slot.row}:${slot.column}`))

    expect(planned.ok && planned.rowCount).toBe(64)
    expect(slots.size).toBe(512)
    expect(keys.size).toBe(512)
    expect([...slots.values()].every((slot) =>
      slot.row >= 0 && slot.row < 64 && slot.column >= 0 && slot.column <= 7))
      .toBe(true)
  })

  it('rejects family separation that needs extra rows even with fewer than 512 cells', () => {
    const images = Array.from({ length: 505 }, (_, index) =>
      cell(
        `img-${String(index).padStart(3, '0')}`,
        index % 64,
        index % 8,
        'image',
      ))
    const overflow = planNotebookArrangement(document([
      ...images,
      cell('prompt', 0, 1),
    ]))
    expect(overflow).toMatchObject({ ok: false, code: 'capacity' })
    expect(!overflow.ok && overflow.message).toContain('needs 65 rows')
    expect(!overflow.ok && overflow.message).toContain('supports 64')
    expect(!overflow.ok && 'slots' in overflow).toBe(false)
  })

  it('waits for refreshed layout before revealing the upper-left', () => {
    const frames: FrameRequestCallback[] = []
    const scrolls: ScrollToOptions[] = []
    const target = {
      scrollTo: (options: ScrollToOptions) => scrolls.push(options),
    }

    revealNotebookArrangement(
      () => target,
      (callback) => {
        frames.push(callback)
        return frames.length
      },
    )

    expect(scrolls).toEqual([])
    frames.shift()?.(0)
    expect(scrolls).toEqual([])
    frames.shift()?.(16)
    expect(scrolls).toEqual([{
      left: 0,
      top: 0,
      behavior: 'smooth',
    }])
  })

  it('persists identities, edges, outputs, and input-slot prompts through the real move mutation', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'videobook-auto-arrange-'))
    const books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    try {
      await books.ready()
      const defs = videobookDomainDefs(scopedBookEngine, books)
      const byName = new Map(defs.map((def) => [def.name, def]))
      const created = resultJson(await byName.get('create_book')!.handler({
        name: 'auto-arrange',
      })) as { bookId: string }
      const managed = books.get(created.bookId)
      expect(managed.ok).toBe(true)
      if (!managed.ok) return
      const engine = managed.value.engine
      const initial = value(engine.notebooks.read(engine.notebooks.list()[0]!.id))
      const artifact = await engine.artifacts.create('image', 'arrange-still')
      expect(artifact.ok).toBe(true)
      if (!artifact.ok) return
      const image = engine.notebooks.createCell({
        type: 'image',
        label: 'image',
        prompt: 'image prompt',
        slot: { row: 8, column: 1 },
        outputArtifactId: artifact.value.artifactId,
      })
      // Generation prompts name inputs by slot, so the move must leave this
      // prompt byte-for-byte unchanged.
      const seededPrompt = 'Reference image @image1: image prompt. Preserve subject, composition. Render clean image.'
      const generateImage = engine.notebooks.createCell({
        type: 'generate_image',
        label: 'generate-image',
        prompt: seededPrompt,
        slot: { row: 5, column: 6 },
        inputs: {
          initialGenerationPrompt: {
            prompt: seededPrompt,
            version: 1,
          },
        },
      })
      const video = engine.notebooks.createCell({
        type: 'video',
        label: 'video',
        prompt: 'video prompt',
        slot: { row: 2, column: 3 },
      })
      value(await engine.notebooks.write({
        ...initial,
        cells: [image, generateImage, video],
        edges: [engine.notebooks.createEdge({
          source: image.id,
          target: generateImage.id,
          targetInput: 'image',
        })],
      }))
      const before = value(engine.notebooks.read(initial.id))
      const planned = planNotebookArrangement(before)
      expect(planned.ok).toBe(true)
      if (!planned.ok) return
      expect(assignmentMap(planned)).toEqual(new Map([
        [image.id, { row: 0, column: 0 }],
        [generateImage.id, { row: 1, column: 0 }],
        [video.id, { row: 2, column: 0 }],
      ]))
      expect(before.cells.find((item) => item.id === generateImage.id)?.prompt)
        .toBe(seededPrompt)

      resultJson(await withBookContext(
        { bookId: created.bookId, engine },
        () => byName.get('move_notebook_cells')!.handler({
          book_id: created.bookId,
          notebook_id: initial.id,
          expected_revision: engine.head,
          slots: planned.slots,
        }),
      ))
      const after = value(engine.notebooks.read(initial.id))
      const withoutSlots = (items: NotebookCell[]) => items
        .map(({ slot: _slot, prompt: _prompt, inputs: _inputs, ...item }) => item)
        .sort((leftItem, rightItem) => leftItem.id.localeCompare(rightItem.id))
      const persistedSlots = after.cells
        .map((item) => ({ id: item.id, slot: item.slot }))
        .sort((leftItem, rightItem) => leftItem.id.localeCompare(rightItem.id))
      const plannedSlots = planned.slots
        .map(({ id, row, column }) => ({ id, slot: { row, column } }))
        .sort((leftItem, rightItem) => leftItem.id.localeCompare(rightItem.id))

      expect(persistedSlots).toEqual(plannedSlots)
      expect(withoutSlots(after.cells)).toEqual(withoutSlots(before.cells))
      expect(after.edges).toEqual(before.edges)
      expect(after.cells.find((item) => item.id === image.id)?.outputArtifactId)
        .toBe(artifact.value.artifactId)
      expect(after.cells.find((item) => item.id === generateImage.id)?.prompt)
        .toBe(seededPrompt)
    } finally {
      await books.close()
      await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

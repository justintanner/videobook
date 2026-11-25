import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookCellType, NotebookEdge, NotebookGridSlot } from 'videobook-engine'
import { arrangeNotebookRounds } from '../../server/src/notebook-rounds-arrange.js'
import {
  notebookRoundHeaderSlots,
  notebookRoundsModel,
} from '../../server/src/notebook-rounds.js'
import {
  placeDerivedCell,
  placeDerivedCells,
  placeGenerationTake,
  placeLooseCell,
  placeNewGenerator,
} from '../../server/src/notebook-rounds-placement.js'
import {
  notebookPromptChange,
  notebookRoundHeaders,
} from '../../src/videobook/notebook-round-headers.js'

interface Notebook {
  cells: NotebookCell[]
  edges: NotebookEdge[]
}

const V1 = 'Subject image @image1. Motion video @video1. Animate subject. Match motion, timing.'
const V2 = 'exactly like @video1 but replace the pig with the man in the green shirt @image1 at 10s his boat sinks quickly into the water, realistic, no talking'
const V3 = 'exactly like @video1 the man in the green shirt @image1 gets in the boat with the pig at 10s his boat sinks quickly into the water, realistic, no talking'
const V4 = `${V3}, single camera shot`

function cell(id: string, type: NotebookCellType, extra: Partial<NotebookCell> = {}): NotebookCell {
  return { id, type, slot: { row: 0, column: 0 }, ...extra }
}

function take(id: string, prompt: string, extra: Partial<NotebookCell> = {}): NotebookCell {
  return cell(id, 'video', { prompt, inputs: { producerCellId: '05-gen', mediaRole: 'generate-video-output' }, ...extra })
}

function edge(source: string, target: string, targetInput: string): NotebookEdge {
  return { id: `${source}>${target}`, source, target, targetInput }
}

function loyk2(): Notebook {
  return {
    cells: [
      cell('01-source', 'video', { inputs: { sourceOperation: 'download_video' } }),
      cell('02-trim', 'video', { inputs: { mediaRole: 'cut-clip-output', sourceCellId: '01-source' } }),
      cell('03-character', 'image'),
      cell('04-pending', 'generate_video', { prompt: V1 }),
      cell('05-gen', 'generate_video', { prompt: V4 }),
      take('06-take1', V1),
      take('07-take2', V2),
      take('08-take3', V3),
      take('09-take4', V3),
      take('10-take5', V4, { outputArtifactId: 'art-take5' }),
      take('11-take6', V4),
      cell('12-graphics', 'video', { inputs: { sourceOperation: 'video_graphics', sourceArtifactId: 'art-take5' } }),
      cell('13-logo', 'image'),
      cell('14-post', 'post', { inputs: { post: { source: { cellId: '12-graphics' } } } }),
    ],
    edges: [
      edge('03-character', '04-pending', 'image'),
      edge('01-source', '04-pending', 'video'),
      edge('01-source', '02-trim', 'segment'),
      edge('02-trim', '05-gen', 'video'),
      edge('03-character', '05-gen', 'image'),
      ...['06-take1', '07-take2', '08-take3', '09-take4', '10-take5', '11-take6'].map((id) => edge('05-gen', id, 'media')),
      edge('12-graphics', '14-post', 'post'),
    ],
  }
}

function arranged(notebook: Notebook): Notebook {
  const result = arrangeNotebookRounds(notebook)
  if (!result.ok) throw new Error(`needs ${result.requiredRows} rows`)
  const slots = new Map(result.slots.map(({ id, row, column }) => [id, { row, column }]))
  return { ...notebook, cells: notebook.cells.map((item) => ({ ...item, slot: slots.get(item.id) ?? item.slot })) }
}

function slotsOf(notebook: Notebook): Record<string, NotebookGridSlot> {
  return Object.fromEntries(notebook.cells.map((item) => [item.id, item.slot]))
}

function at(row: number, column: number): NotebookGridSlot {
  return { row, column }
}

function withCell(notebook: Notebook, cells: NotebookCell[], added: NotebookCell, edges: NotebookEdge[] = []): Notebook {
  return { cells: [...cells, added], edges: [...notebook.edges, ...edges] }
}

function expectClean(notebook: Notebook): void {
  expect(slotsOf(arranged(notebook))).toEqual(slotsOf(notebook))
}

describe('rounds layout (Clean)', () => {
  it('runs inputs into each prompt version, its takes underneath and finishing beside the picked take', () => {
    const clean = arranged(loyk2())
    expect(slotsOf(clean)).toEqual({
      '01-source': at(0, 0),
      '02-trim': at(0, 1),
      '05-gen': at(0, 5),
      '03-character': at(1, 1),
      '06-take1': at(1, 2),
      '07-take2': at(1, 3),
      '08-take3': at(1, 4),
      '10-take5': at(1, 5),
      '12-graphics': at(1, 6),
      '14-post': at(1, 7),
      '09-take4': at(2, 4),
      '11-take6': at(2, 5),
      '04-pending': at(3, 2),
      '13-logo': at(4, 0),
    })
    expect(notebookRoundHeaderSlots(notebookRoundsModel(clean)).map(({ round, slot }) => ({ round, slot }))).toEqual([
      { round: 0, slot: at(0, 2) },
      { round: 1, slot: at(0, 3) },
      { round: 2, slot: at(0, 4) },
    ])
    expectClean(clean)
  })

  it('wraps prompt versions that run past the right edge into a group under the first', () => {
    const prompts = Array.from({ length: 9 }, (_, index) => `version ${index + 1}`)
    const notebook: Notebook = {
      cells: [
        cell('05-gen', 'generate_video', { prompt: prompts[8] }),
        ...prompts.map((prompt, index) => take(`take-${index + 1}`, prompt)),
      ],
      edges: [],
    }
    const clean = slotsOf(arranged(notebook))
    expect(clean['take-1']).toEqual(at(1, 0))
    expect(clean['take-8']).toEqual(at(1, 7))
    expect(clean['05-gen']).toEqual(at(2, 0))
    expect(clean['take-9']).toEqual(at(3, 0))
  })

  it('lays linked cells without a generator out as chains, then loose cells, then Timeline rows', () => {
    const notebook: Notebook = {
      cells: [
        cell('timeline', 'timeline', { slot: at(0, 0) }),
        cell('image', 'image', { slot: at(5, 3) }),
        cell('source', 'video', { slot: at(2, 2) }),
        cell('clip', 'video', { slot: at(9, 9 % 8), inputs: { sourceCellId: 'source' } }),
        cell('post', 'post', { slot: at(4, 4), inputs: { post: { source: { cellId: 'clip' } } } }),
      ],
      edges: [],
    }
    expect(slotsOf(arranged(notebook))).toEqual({
      source: at(0, 0),
      clip: at(0, 1),
      post: at(0, 2),
      image: at(1, 0),
      timeline: at(2, 0),
    })
  })

  it('places linked cells that only form a cycle', () => {
    const notebook: Notebook = {
      cells: [cell('img', 'image', { slot: at(9, 1) }), cell('vid', 'video', { slot: at(1, 1) })],
      edges: [edge('img', 'vid', 'image'), edge('vid', 'img', 'video')],
    }
    expect(slotsOf(arranged(notebook))).toEqual({ img: at(0, 0), vid: at(0, 1) })
  })

  it('reports the rows a layout needs when it outgrows the board', () => {
    const images = Array.from({ length: 504 }, (_, index) =>
      cell(`img-${String(index).padStart(3, '0')}`, 'image', { slot: at(Math.floor(index / 8), index % 8) }))
    const result = arrangeNotebookRounds({
      cells: [...images, cell('gen', 'generate_image'), cell('out', 'image', { inputs: { producerCellId: 'gen' } })],
      edges: [],
    })
    expect(result).toEqual({ ok: false, requiredRows: 65 })
  })
})

describe('rounds placement keeps a clean board clean', () => {
  it('puts a take with an unchanged prompt under its round and pushes the next band down', () => {
    const clean = arranged(loyk2())
    const placed = placeGenerationTake(clean, '05-gen')
    expect(placed.slot).toEqual(at(3, 5))
    const next = withCell(clean, placed.cells, take('15-take7', V4, { slot: placed.slot }), [edge('05-gen', '15-take7', 'media')])
    expect(slotsOf(next)['04-pending']).toEqual(at(4, 2))
    expectClean(next)
  })

  it('opens a new round for a changed prompt and moves the generator onto it', () => {
    const clean = arranged(loyk2())
    const edited = { ...clean, cells: clean.cells.map((item) => item.id === '05-gen' ? { ...item, prompt: `${V4}, slow motion` } : item) }
    const placed = placeGenerationTake(edited, '05-gen')
    expect(placed.slot).toEqual(at(4, 2))
    const next = withCell(edited, placed.cells, take('15-take7', `${V4}, slow motion`, { slot: placed.slot }), [edge('05-gen', '15-take7', 'media')])
    expect(slotsOf(next)['05-gen']).toEqual(at(3, 2))
    expect(notebookRoundHeaderSlots(notebookRoundsModel(next)).map(({ slot }) => slot)).toContainEqual(at(0, 5))
    expectClean(next)
  })

  it('opens a new round beside the generator when nothing is in the way', () => {
    const notebook = arranged({
      cells: [cell('05-gen', 'generate_video', { prompt: 'two' }), take('06-take1', 'one'), take('07-take2', 'two')],
      edges: [],
    })
    const edited = { ...notebook, cells: notebook.cells.map((item) => item.id === '05-gen' ? { ...item, prompt: 'three' } : item) }
    const placed = placeGenerationTake(edited, '05-gen')
    expect(placed.slot).toEqual(at(1, 2))
    const next = withCell(edited, placed.cells, take('08-take3', 'three', { slot: placed.slot }))
    expect(slotsOf(next)['05-gen']).toEqual(at(0, 2))
    expectClean(next)
  })

  it('gives a generator its first take directly underneath', () => {
    const notebook = arranged({ cells: [cell('source', 'video'), cell('05-gen', 'generate_video', { prompt: 'go' })], edges: [edge('source', '05-gen', 'video')] })
    const placed = placeGenerationTake(notebook, '05-gen')
    expect(placed.slot).toEqual(at(1, 1))
    expectClean(withCell(notebook, placed.cells, take('06-take1', 'go', { slot: placed.slot })))
  })

  it('finishes a take beside its round and a post beside its render', () => {
    const clean = arranged(loyk2())
    const render = placeDerivedCell(clean, '11-take6')
    expect(render.slot).toEqual(at(2, 6))
    const rendered = withCell(clean, render.cells, cell('15-graphics', 'video', { slot: render.slot, inputs: { sourceCellId: '11-take6' } }))
    expectClean(rendered)
    const post = placeDerivedCell(rendered, '15-graphics')
    expect(post.slot).toEqual(at(2, 7))
    expectClean(withCell(rendered, post.cells, cell('16-post', 'post', { slot: post.slot, inputs: { post: { source: { cellId: '15-graphics' } } } })))
  })

  it('keeps clips of an input in the input area instead of a round column', () => {
    const clean = arranged(loyk2())
    expect(placeDerivedCell(clean, '01-source').slot).toEqual(at(2, 1))
    expect(placeDerivedCells(clean, '02-trim', 2).slots).toEqual([at(2, 1), at(3, 1)])
  })

  it('starts a new generator on its own band and appends loose media after the loose cells', () => {
    const clean = arranged(loyk2())
    expect(placeNewGenerator(clean)).toEqual(at(5, 2))
    expect(placeLooseCell(clean)).toEqual(at(4, 1))
    expect(placeNewGenerator({ cells: [cell('source', 'video')], edges: [] }, ['source'])).toEqual(at(0, 1))
  })
})

describe('round history tiles', () => {
  it('describes what changed between prompt versions', () => {
    expect(notebookPromptChange(V1, V2)).toEqual({ kind: 'rewritten' })
    expect(notebookPromptChange(V2, V3)).toEqual({
      kind: 'edited',
      removed: ['but replace the pig with'],
      added: ['gets in the boat with the pig'],
    })
    expect(notebookPromptChange(V3, V4)).toEqual({ kind: 'edited', removed: [], added: ['single camera shot'] })
  })

  it('heads every earlier prompt version on the clean board', () => {
    const headers = notebookRoundHeaders(arranged(loyk2()))
    expect(headers.map(({ version, takeCount, slot, change }) => ({ version, takeCount, slot, change: change.kind }))).toEqual([
      { version: 1, takeCount: 1, slot: at(0, 2), change: 'first' },
      { version: 2, takeCount: 1, slot: at(0, 3), change: 'rewritten' },
      { version: 3, takeCount: 2, slot: at(0, 4), change: 'edited' },
    ])
  })

  it('draws no history tile for a generator with a single prompt version', () => {
    const notebook = arranged({ cells: [cell('05-gen', 'generate_video', { prompt: 'go' }), take('06-take1', 'go'), take('07-take2', 'go')], edges: [] })
    expect(notebookRoundHeaders(notebook)).toEqual([])
  })
})

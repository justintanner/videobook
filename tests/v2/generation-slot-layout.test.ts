import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import { resolveModel } from '../../server/src/media/descriptor.js'
import { notebookGenerationInputContract } from '../../server/src/notebook-generation-contract.js'
import {
  applySlotEdit,
  remapSlotPrompt,
  slotCapacity,
  slotDropError,
  slotItemPlaceholder,
  slotItemTokens,
  slotLayout,
  slotLayoutConnections,
  slotLegacySettingNames,
  slotSourceKinds,
  type SlotConnection,
  type SlotLayoutContext,
} from '../../src/videobook/generation-slot-layout.js'

const TARGET = '01900000-0000-7000-8000-00000000a000'
const cell = (id: string, type: NotebookCell['type']) => ({ id: `01900000-0000-7000-8000-00000000${id}`, type })
const a = cell('a001', 'image')
const b = cell('a002', 'image')
const c = cell('a003', 'image')
const voice = cell('a004', 'audio')
const target = { id: TARGET, type: 'generate_video' as const, inputs: { generationMode: 'i2v' } }
const cells = [target, a, b, c, voice]
const kinds = slotSourceKinds(cells)

function context(model: string, modeId: string, settings: Record<string, unknown> = {}): SlotLayoutContext {
  const mode = notebookGenerationInputContract(resolveModel(model)).modes.find((candidate) => candidate.id === modeId)!
  return { mode, modeId, kinds, settings }
}

const GROK = 'kie:grok-imagine-video-1-5-preview'
const grokConnections: SlotConnection[] = [
  { sourceCellId: a.id, targetInput: 'image' },
  { sourceCellId: c.id, targetInput: 'keyframe_2', params: { timestamp_s: 6 } },
  { sourceCellId: b.id, targetInput: 'keyframe' },
  { sourceCellId: voice.id, targetInput: 'replace_audio' },
]
const sources = (layout: ReturnType<typeof slotLayout>) => Object.fromEntries(layout.slots
  .filter((column) => column.items.length > 0)
  .map((column) => [column.spec.target, column.items.map((item) => item.sourceCellId)]))

describe('generation slot layout', () => {
  it('shows each connection in the slot the request sends it to', () => {
    const layout = slotLayout(grokConnections, context(GROK, 'i2v', { keyframe_1_seconds: 2 }))
    expect(layout.slots.map((column) => column.spec.label)).toEqual(['Reference images', 'First frame', 'Last frame', 'Keyframes', 'Replacement audio'])
    expect(sources(layout)).toEqual({ image: [a.id], keyframe: [b.id, c.id], replace_audio: [voice.id] })
    expect(layout.slots.find((column) => column.spec.target === 'keyframe')!.items.map((item) => item.params))
      .toEqual([{ timestamp_s: 2 }, { timestamp_s: 6 }])
    expect(layout.unplaced).toEqual([])
  })

  it('moves the first images into the frames of a model without reference images and keeps the rest aside', () => {
    const layout = slotLayout([
      { sourceCellId: c.id, targetInput: 'image_3' },
      { sourceCellId: a.id, targetInput: 'image' },
      { sourceCellId: b.id, targetInput: 'image_2' },
    ], context('kie:bytedance/seedance-2-5', 'i2v'))
    expect(sources(layout)).toEqual({ first_frame: [a.id], last_frame: [b.id] })
    expect(layout.unplaced.map((item) => [item.sourceCellId, item.port])).toEqual([[c.id, 'image_3']])
    const change = slotLayoutConnections(layout)
    expect(change.connections).toEqual([
      { sourceCellId: a.id, targetInput: 'first_frame' },
      { sourceCellId: b.id, targetInput: 'last_frame' },
      { sourceCellId: c.id, targetInput: 'image_3' },
    ])
  })

  it('moves between slots, reorders within one and copies with Option, renumbering ports and keeping params', () => {
    const grok = context(GROK, 'i2v')
    const layout = slotLayout(grokConnections, grok)
    const moved = slotLayoutConnections(applySlotEdit(layout, { kind: 'move', from: { target: 'keyframe', index: 1 }, to: { target: 'image', index: 0 }, copy: false }, kinds))
    expect(moved.connections).toEqual([
      { sourceCellId: c.id, targetInput: 'image', params: { timestamp_s: 6 } },
      { sourceCellId: a.id, targetInput: 'image_2' },
      { sourceCellId: b.id, targetInput: 'keyframe' },
      { sourceCellId: voice.id, targetInput: 'replace_audio' },
    ])
    expect([...moved.identity]).toEqual([
      [`${c.id}:keyframe_2`, 'image'], [`${a.id}:image`, 'image_2'], [`${b.id}:keyframe`, 'keyframe'], [`${voice.id}:replace_audio`, 'replace_audio'],
    ])
    const reordered = slotLayoutConnections(applySlotEdit(layout, { kind: 'move', from: { target: 'keyframe', index: 0 }, to: { target: 'keyframe', index: 2 }, copy: false }, kinds))
    expect(reordered.connections.filter((connection) => connection.targetInput.startsWith('keyframe'))).toEqual([
      { sourceCellId: c.id, targetInput: 'keyframe', params: { timestamp_s: 6 } },
      { sourceCellId: b.id, targetInput: 'keyframe_2' },
    ])
    const copied = slotLayoutConnections(applySlotEdit(layout, { kind: 'move', from: { target: 'image', index: 0 }, to: { target: 'keyframe', index: 0 }, copy: true }, kinds))
    expect(copied.connections.map((connection) => [connection.sourceCellId, connection.targetInput])).toEqual([
      [a.id, 'image'], [a.id, 'keyframe'], [b.id, 'keyframe_2'], [c.id, 'keyframe_3'], [voice.id, 'replace_audio'],
    ])
    expect(copied.identity.get(`${a.id}:image`)).toBe('image')
  })

  it('keeps the ports of slots an edit does not touch', () => {
    const seedance = context('kie:bytedance/seedance-2-5', 'r2v')
    const layout = slotLayout([
      { sourceCellId: a.id, targetInput: 'image' },
      { sourceCellId: b.id, targetInput: 'first_frame' },
    ], seedance)
    expect(sources(layout)).toEqual({ image: [a.id, b.id] })
    const added = applySlotEdit(layout, { kind: 'add', sourceCellId: voice.id, to: { target: 'audio', index: 0 } }, kinds)
    expect(slotLayoutConnections(added, layout).connections).toEqual([
      { sourceCellId: a.id, targetInput: 'image' },
      { sourceCellId: b.id, targetInput: 'first_frame' },
      { sourceCellId: voice.id, targetInput: 'audio' },
    ])
    const reordered = applySlotEdit(layout, { kind: 'move', from: { target: 'image', index: 1 }, to: { target: 'image', index: 0 }, copy: false }, kinds)
    expect(slotLayoutConnections(reordered, layout).connections).toEqual([
      { sourceCellId: b.id, targetInput: 'image' },
      { sourceCellId: a.id, targetInput: 'image_2' },
    ])
  })

  it('adds from the board, removes and edits per-item params', () => {
    const grok = context(GROK, 'i2v', { duration: 10 })
    const layout = slotLayout(grokConnections.slice(0, 1), grok)
    const added = applySlotEdit(layout, { kind: 'add', sourceCellId: b.id, to: { target: 'keyframe', index: 0 } }, kinds)
    const timed = applySlotEdit(added, { kind: 'params', at: { target: 'keyframe', index: 0 }, name: 'timestamp_s', value: 4.5 }, kinds)
    expect(slotLayoutConnections(timed).connections).toEqual([
      { sourceCellId: a.id, targetInput: 'image' },
      { sourceCellId: b.id, targetInput: 'keyframe', params: { timestamp_s: 4.5 } },
    ])
    const cleared = applySlotEdit(timed, { kind: 'params', at: { target: 'keyframe', index: 0 }, name: 'timestamp_s', value: undefined }, kinds)
    expect(slotLayoutConnections(cleared).connections[1]).toEqual({ sourceCellId: b.id, targetInput: 'keyframe' })
    expect(slotLayoutConnections(applySlotEdit(timed, { kind: 'remove', from: { target: 'image', index: 0 } }, kinds)).connections)
      .toEqual([{ sourceCellId: b.id, targetInput: 'keyframe', params: { timestamp_s: 4.5 } }])
    const keyframes = timed.slots.find((column) => column.spec.target === 'keyframe')!
    expect(slotItemPlaceholder(keyframes.spec.itemParams[0]!, keyframes, 0, grok.settings)).toBe(5)
  })

  it('refuses drops of the wrong kind, into a full slot or past a limit the settings set', () => {
    const grok = context(GROK, 'i2v', { resolution: '1080p' })
    const layout = slotLayout(grokConnections, grok)
    expect(slotDropError(layout, { kind: 'add', sourceCellId: voice.id, to: { target: 'keyframe', index: 0 } }, grok)).toBe('Keyframes: images only')
    const framed = applySlotEdit(layout, { kind: 'add', sourceCellId: b.id, to: { target: 'first_frame', index: 0 } }, kinds)
    expect(slotDropError(framed, { kind: 'add', sourceCellId: c.id, to: { target: 'first_frame', index: 0 } }, grok)).toBe('First frame: full at 1')
    expect(slotDropError(layout, { kind: 'move', from: { target: 'keyframe', index: 0 }, to: { target: 'image', index: 1 }, copy: false }, grok))
      .toBe('1080p takes one reference image')
    expect(slotDropError(layout, { kind: 'move', from: { target: 'keyframe', index: 0 }, to: { target: 'keyframe', index: 2 }, copy: false }, grok)).toBeNull()
    expect(slotDropError(layout, { kind: 'move', from: { target: 'keyframe', index: 0 }, to: { target: 'image', index: 1 }, copy: false }, context(GROK, 'i2v'))).toBeNull()
    const images = layout.slots[0]!
    expect(slotCapacity(images.spec, grok.mode.limits, grok.settings)).toBe(1)
    expect(slotCapacity(images.spec, grok.mode.limits, {})).toBeNull()
    expect([...slotLegacySettingNames(grok.mode)]).toEqual(['keyframe_1_seconds', 'keyframe_2_seconds', 'keyframe_3_seconds', 'keyframe_4_seconds'])
  })

  it('names each input with its prompt token and moves a written prompt with its inputs', () => {
    const grok = context(GROK, 'i2v')
    const tokens = slotItemTokens(TARGET, cells, grokConnections, 'i2v')
    expect([a, b, c].map((source) => tokens.get(`${source.id}:${grokConnections.find((connection) => connection.sourceCellId === source.id)!.targetInput}`)))
      .toEqual(['image1', 'keyframe1', 'keyframe2'])
    const change = slotLayoutConnections(applySlotEdit(slotLayout(grokConnections, grok), {
      kind: 'move', from: { target: 'keyframe', index: 1 }, to: { target: 'image', index: 0 }, copy: false,
    }, kinds))
    expect(remapSlotPrompt('Hold @image1, then @keyframe1 and @keyframe2', TARGET, cells, grokConnections, change))
      .toBe('Hold @image2, then @keyframe1 and @image1')
  })
})

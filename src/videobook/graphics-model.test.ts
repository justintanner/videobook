import { describe, expect, it } from 'vitest'
import type { GraphicsLayerLayout } from '../../server/src/graphics/layout'
import { graphicsDocumentFromLayers, type GraphicsDocument, type GraphicsQrLayerInput } from '../../server/src/graphics/model'
import type { GraphicsEdit } from '../../server/src/graphics/edits'
import { platformWatermarkDocument } from '../../server/src/graphics/starters'
import { watermarkLayerInputs } from '../../server/src/graphics/watermark-profile'
import { LIGHTNING_WATERMARK_PROFILE, watermarkProfileFor } from '../../server/src/lightning-defaults'
import {
  editGraphicsHistory,
  graphicsAddLayer,
  graphicsBlockText,
  graphicsBurnedNotice,
  graphicsDrawnDocument,
  graphicsEditorTarget,
  graphicsFillSuggestion,
  graphicsImageChoices,
  graphicsImageEdits,
  graphicsLayerSummary,
  graphicsLayoutWarnings,
  graphicsNextLayerId,
  graphicsOpenEdits,
  graphicsOverlayImages,
  graphicsPercent,
  graphicsRenderBlocker,
  graphicsRenderQueuedMessage,
  graphicsSelectionAfterRemove,
  graphicsSlotText,
  graphicsSuggestKind,
  graphicsTemplateChoices,
  graphicsTemplateMessage,
  graphicsTextEdits,
  graphicsToolError,
  graphicsWatermarkSwitchEdits,
  graphicsWatermarkTarget,
  parseGraphicsRead,
  parseGraphicsRender,
  parseGraphicsSuggestions,
  stepGraphicsHistory,
  type GraphicsHistory,
  type GraphicsRead,
} from './graphics-model'

const THAI_TITLE = 'ติดไฟแดงยังไงให้เท่ได้ขนาดนี้'

function titled(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: 'scrim', edge: 'bottom' },
    { kind: 'text', name: 'Title', items: [{ text: '', slot: 'headline', size: 0.09 }, { text: '', slot: 'secondary', size: 0.045 }] },
    { kind: 'text', name: 'Handle', items: [{ text: 'jtbkk', slot: 'handle', icon: 'tiktok' }] },
  ])
}

function lowerThird(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: 'text', name: 'Lower third', items: [{ text: '', slot: 'headline' }, { text: '', slot: 'secondary' }, { text: '', slot: 'credit', icon: 'camera' }] },
  ])
}

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset_id: 'video-1',
    address: '@a1',
    label: 'red light',
    source: { width: 1080, height: 1920, duration_seconds: 8, fps: 30, source_hash: 'hash' },
    saved: false,
    revision: 'default:abc',
    updated_at: null,
    document: titled(),
    fill: { handle: 'jtbkk', profile_url: 'https://www.tiktok.com/@jtbkk', credit: 'TikTok/@pomkondeena' },
    starters: [{ id: 'tiktok-title', name: 'TikTok title', document: titled() }, { id: 'lower-third', name: 'Lower third', document: lowerThird() }],
    images: { logo: { label: 'logo', url: '/files/book/logo/original.png', width: 40, height: 20 }, broken: { label: null, url: null, width: null, height: null } },
    render: null,
    burned: null,
    ...overrides,
  }
}

function read(overrides: Record<string, unknown> = {}): GraphicsRead {
  return parseGraphicsRead(wire(overrides))
}

function history(document: GraphicsDocument): GraphicsHistory {
  return { document, past: [], future: [], coalesceKey: null }
}

function edited(current: GraphicsHistory, ...args: Parameters<typeof editGraphicsHistory> extends [unknown, ...infer Rest] ? Rest : never): GraphicsHistory {
  const result = editGraphicsHistory(current, ...args)
  if (!result.ok) throw new Error(result.message)
  return result.history
}

describe('graphics read model', () => {
  it('parses a get answer with its documents, render and burned provenance', () => {
    const parsed = read({
      render: { request_id: 'r1', status: 'running', job_id: 4, output_asset_id: 'copy', cell_id: null, address: null, error: null },
      burned: { request_id: 'r0', output: 'new', source_asset_id: 'source', source_hash: 'h', rendered_at: '2026-11-10T00:00:00Z', layers: [{ id: 'l2', kind: 'text', name: 'Title' }] },
    })
    expect(parsed.document.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    expect(parsed.starters.map((starter) => starter.id)).toEqual(['tiktok-title', 'lower-third'])
    expect(parsed.render).toMatchObject({ status: 'running', job_id: 4 })
    expect(parsed.burned).toMatchObject({ output: 'new', source_asset_id: 'source' })
    expect(() => parseGraphicsRead(wire({ document: { version: 2, layers: [], nextId: 1 } }))).toThrow()
    expect(parseGraphicsRender({ render: { request_id: 'r2', status: 'queued', job_id: 7, output_asset_id: 'copy', cell_id: null, address: null, error: null } })).toMatchObject({ job_id: 7 })
  })

  it('decodes structured tool errors and falls back to the plain message', () => {
    expect(graphicsToolError(new Error(JSON.stringify({ status: 'conflict', message: 'Changed', revision: 'r9' })))).toEqual({ status: 'conflict', message: 'Changed', revision: 'r9', layerId: null })
    expect(graphicsToolError(new Error(JSON.stringify({ status: 'invalid', message: 'Missing image', layer_id: 'l5' })))).toMatchObject({ status: 'invalid', layerId: 'l5' })
    expect(graphicsToolError(new Error('socket closed'))).toEqual({ status: 'error', message: 'socket closed', revision: null, layerId: null })
  })

  it('offers fill values only for the slots it knows', () => {
    const parsed = read()
    expect(graphicsFillSuggestion(parsed, 'credit')).toBe('TikTok/@pomkondeena')
    expect(graphicsFillSuggestion(parsed, 'handle')).toBe('jtbkk')
    expect(graphicsFillSuggestion(parsed, 'headline')).toBeNull()
    expect(graphicsSlotText(parsed.document, 'headline')).toBe('')
    expect(graphicsSlotText(parsed.document, 'credit')).toBeNull()
  })

  it('draws only the images it can size', () => {
    expect(graphicsOverlayImages(read())).toEqual({ logo: { src: '/files/book/logo/original.png', width: 40, height: 20 } })
    expect(graphicsOverlayImages(null)).toEqual({})
  })
})

describe('graphics templates', () => {
  const brand = { id: 'saved-1', name: 'Brand look', updated_at: '2026-11-10T00:00:00Z', document: lowerThird(), missing_layer_ids: [] }
  const logo = { id: 'saved-2', name: 'With logo', updated_at: '2026-11-10T00:00:00Z', document: titled(), missing_layer_ids: ['l4', 'l5'] }

  it('lists the starters, then the saved templates, and marks the book default', () => {
    const parsed = read({ templates: [brand, logo], default_template_id: 'saved-1' })
    expect(parsed.templates[0].document).toEqual(lowerThird())
    expect(graphicsTemplateChoices(parsed).map(({ id, saved, isDefault, missingImages }) => ({ id, saved, isDefault, missingImages }))).toEqual([
      { id: 'tiktok-title', saved: false, isDefault: false, missingImages: 0 },
      { id: 'lower-third', saved: false, isDefault: false, missingImages: 0 },
      { id: 'saved-1', saved: true, isDefault: true, missingImages: 0 },
      { id: 'saved-2', saved: true, isDefault: false, missingImages: 2 },
    ])
    const older = read()
    expect(older.templates).toEqual([])
    expect(graphicsTemplateChoices(older).filter((choice) => choice.isDefault).map((choice) => choice.id)).toEqual(['tiktok-title'])
    expect(() => read({ templates: [{ ...brand, document: { version: 2 } }] })).toThrow()
  })

  it('says what each template operation did', () => {
    const template = { template: { id: 'saved-1', name: 'Brand look', updated_at: 'now' }, templates: [], default_template_id: 'tiktok-title' }
    expect(graphicsTemplateMessage('save_template', template)).toBe('Saved “Brand look” as a template.')
    expect(graphicsTemplateMessage('save_template', template, { overwrite: true })).toBe('Updated “Brand look” with this look.')
    expect(graphicsTemplateMessage('rename_template', template)).toBe('Renamed the template to “Brand look”.')
    expect(graphicsTemplateMessage('delete_template', template)).toBe('Deleted “Brand look”.')
    expect(graphicsTemplateMessage('set_default_template', { templates: [], default_template_id: 'lower-third' }, { name: 'Lower third' }))
      .toBe('Lower third is now the look for videos in this book that have no graphics yet.')
    const copy = { from_book_name: 'daily-1109', copied: [{ name: 'Brand' }, { name: 'Promo' }], skipped: [], images: [], missing_images: [] }
    expect(graphicsTemplateMessage('copy_templates', copy)).toBe('Copied 2 templates from daily-1109.')
    expect(graphicsTemplateMessage('copy_templates', { ...copy, copied: [{ name: 'Brand' }], skipped: [{ name: 'Promo' }], missing_images: ['logo'] }))
      .toBe('Copied 1 template from daily-1109. Skipped Promo: that name is already used here. 1 image was missing in daily-1109, so its layer is kept and marked missing.')
    expect(graphicsTemplateMessage('copy_templates', { ...copy, copied: [], skipped: [{ name: 'Brand' }, { name: 'Promo' }] }))
      .toBe('No new templates to copy from daily-1109. Skipped Brand, Promo: that name is already used here.')
  })
})

describe('graphics editor target', () => {
  const assets = [
    { id: 'vid-1', artifactId: 'video-1', label: 'red light', type: 'video', status: 'ready', mediaUrl: '/files/b/video-1/original.mp4' },
    { id: 'vid-2', artifactId: 'video-2', label: 'busy', type: 'video', status: 'processing', mediaUrl: null },
    { id: 'img-1', artifactId: 'logo-1', label: 'logo', type: 'image', status: 'ready', mediaUrl: '/files/b/logo-1/original.png' },
  ]
  const mentions = [{ artifactId: 'video-1', cellAddress: 'a1' }, { artifactId: 'logo-1', cellAddress: 'b2' }, { artifactId: 'video-2', cellAddress: 'a2' }]

  it('resolves cell addresses and ids, with an optional image', () => {
    expect(graphicsEditorTarget({ reference: '@a1', image: '@b2', assets, mentions, notebookId: 'nb' })).toEqual({
      ok: true,
      target: { artifactId: 'video-1', kind: 'video', label: 'red light', mediaUrl: '/files/b/video-1/original.mp4', address: 'a1', notebookId: 'nb', image: 'logo-1', text: null, watermark: null },
    })
    expect(graphicsEditorTarget({ reference: '@a1', image: undefined, text: { headline: 'Red light' }, assets, mentions, notebookId: null })).toMatchObject({ ok: true, target: { text: { headline: 'Red light' } } })
    expect(graphicsEditorTarget({ reference: 'video-1', image: undefined, assets, mentions, notebookId: null })).toMatchObject({ ok: true, target: { image: null, address: 'a1' } })
  })

  it('refuses images, unknown cells, videos still processing and a non-image logo', () => {
    expect(graphicsEditorTarget({ reference: '@b2', image: undefined, assets, mentions, notebookId: null })).toMatchObject({ ok: false, message: expect.stringMatching(/video/u) })
    expect(graphicsEditorTarget({ reference: '@z9', image: undefined, assets, mentions, notebookId: null })).toMatchObject({ ok: false })
    expect(graphicsEditorTarget({ reference: '@a2', image: undefined, assets, mentions, notebookId: null })).toMatchObject({ ok: false, message: expect.stringMatching(/processing/u) })
    expect(graphicsEditorTarget({ reference: '@a1', image: '@a2', assets, mentions, notebookId: null })).toMatchObject({ ok: false, message: expect.stringMatching(/not an image/u) })
  })

  it('adds a named image as a layer once', () => {
    const document = titled()
    const edits = graphicsImageEdits(document, 'logo-1')
    expect(edits).toEqual([{ op: 'add_layer', layer: { kind: 'image', artifactId: 'logo-1' } }])
    const withLogo = edited(history(document), edits, null).document
    expect(withLogo.layers.at(-1)).toMatchObject({ kind: 'image', artifactId: 'logo-1', position: { anchor: 'top-left', x: 0, y: 0, space: 'safe' } })
    expect(graphicsImageEdits(withLogo, 'logo-1')).toEqual([])
    expect(graphicsImageEdits(document, null)).toEqual([])
  })
})

describe('graphics editing history', () => {
  it('coalesces typing into one undo step, then undoes and redoes it', () => {
    const start = history(titled())
    const typed = [...THAI_TITLE].reduce((current, _char, index) => edited(current, [{ op: 'set_slot_text', slot: 'headline', text: THAI_TITLE.slice(0, index + 1) }], 'slot:headline'), start)
    expect(graphicsSlotText(typed.document, 'headline')).toBe(THAI_TITLE)
    expect(typed.past).toHaveLength(1)
    const second = edited(typed, [{ op: 'set_slot_text', slot: 'secondary', text: 'How can you look this cool?' }], 'slot:secondary')
    expect(second.past).toHaveLength(2)
    const undone = stepGraphicsHistory(second, 'undo')!
    expect(graphicsSlotText(undone.document, 'secondary')).toBe('')
    expect(graphicsSlotText(undone.document, 'headline')).toBe(THAI_TITLE)
    const redone = stepGraphicsHistory(undone, 'redo')!
    expect(graphicsSlotText(redone.document, 'secondary')).toBe('How can you look this cool?')
    expect(stepGraphicsHistory(redone, 'redo')).toBeNull()
    expect(stepGraphicsHistory(start, 'undo')).toBeNull()
  })

  it('keeps the typed headline when a starter is applied and reports a bad edit', () => {
    const typed = edited(history(titled()), [{ op: 'set_slot_text', slot: 'headline', text: THAI_TITLE }], 'slot:headline')
    const applied = edited(typed, [{ op: 'apply_template', template: lowerThird() }], null)
    expect(graphicsSlotText(applied.document, 'headline')).toBe(THAI_TITLE)
    expect(graphicsSlotText(applied.document, 'credit')).toBe('')
    expect(editGraphicsHistory(applied, [{ op: 'set_slot_text', slot: 'handle', text: 'x' }], null)).toMatchObject({ ok: false, message: expect.stringMatching(/handle/u) })
  })
})

describe('graphics render guidance', () => {
  it('blocks a conflict, a loading editor and a look with nothing to draw', () => {
    const document = titled()
    expect(graphicsRenderBlocker(document, 8, true)).toMatch(/Reload/u)
    expect(graphicsRenderBlocker(null, null, false)).toMatch(/loading/u)
    expect(graphicsRenderBlocker(graphicsDocumentFromLayers([{ kind: 'text', items: [{ text: ' ' }] }]), 8, false)).toMatch(/Add text/u)
    expect(graphicsRenderBlocker(document, 8, false)).toBeNull()
  })

  it('warns about text that does not fit and missing images', () => {
    const document = graphicsDocumentFromLayers([
      { kind: 'text', name: 'Title', items: [{ text: 'A very long headline that will not fit in two lines at all' }] },
      { kind: 'image', name: 'Logo', artifactId: 'gone' },
    ])
    const [title, logo] = document.layers
    const box = { x: 0, y: 0, width: 10, height: 10 }
    const font = { family: 'Montserrat', weight: 800, size: 40, ascent: 38, descent: 10 }
    const layout = [
      { kind: 'text', layerId: title.id, box, plate: null, overflow: true, items: [{ itemId: title.kind === 'text' ? title.items[0].id : '', font, box, lines: [], icon: null, accent: null, overflow: true }] },
      { kind: 'image', layerId: logo.id, box, missing: true },
    ] as unknown as GraphicsLayerLayout[]
    expect(graphicsLayoutWarnings(document, layout)).toEqual([
      'Title: “A very long headline that will…” does not fit, so it is drawn at the smallest size.',
      'Logo: the image is missing, so nothing is drawn.',
    ])
    expect(graphicsLayoutWarnings(document, null)).toEqual([])
  })

  it('offers the source of a rendered copy and warns before drawing twice', () => {
    const burned = { request_id: 'r', source_hash: 'h', rendered_at: 't', layers: [] }
    expect(graphicsBurnedNotice({ ...burned, output: 'new', source_asset_id: 'source' }, 'copy')).toMatchObject({ sourceId: 'source', message: expect.stringMatching(/twice/u) })
    expect(graphicsBurnedNotice({ ...burned, output: 'replace', source_asset_id: 'video' }, 'video')).toMatchObject({ sourceId: null })
    expect(graphicsBurnedNotice(null, 'video')).toBeNull()
    expect(graphicsRenderQueuedMessage('new', { label: 'red light', address: 'a1' })).toMatch(/@a1/u)
    expect(graphicsRenderQueuedMessage('replace', { label: 'red light', address: null })).toMatch(/Burning graphics into red light/u)
  })
})

function apply(document: GraphicsDocument, edits: GraphicsEdit[]): GraphicsDocument {
  return edited(history(document), edits, null).document
}

describe('graphics text from chat and voice', () => {
  it('keeps the headline, second line and credit a routed plan carries', () => {
    expect(graphicsBlockText({ asset_id: 'video-1', cell_id: 'c1', headline: '  Red light  ', secondary: '', credit: 'TikTok/@pomkondeena', extra: 'x' }))
      .toEqual({ headline: 'Red light', credit: 'TikTok/@pomkondeena' })
    expect(graphicsBlockText({ asset_id: 'video-1', headline: 7 })).toBeNull()
  })

  it('fills the slots the look holds and adds a title block for the ones it lacks', () => {
    const titledDocument = titled()
    const filled = apply(titledDocument, graphicsTextEdits(titledDocument, { headline: THAI_TITLE, secondary: 'How can you look this cool?' }))
    expect(graphicsSlotText(filled, 'headline')).toBe(THAI_TITLE)
    expect(graphicsSlotText(filled, 'secondary')).toBe('How can you look this cool?')
    expect(filled.layers).toHaveLength(titledDocument.layers.length)

    const edits = graphicsTextEdits(titledDocument, { headline: THAI_TITLE, credit: 'TikTok/@pomkondeena' })
    expect(edits.map((edit) => edit.op)).toEqual(['set_slot_text', 'add_layer'])
    const withCredit = apply(titledDocument, edits)
    expect(withCredit.layers.at(-1)).toMatchObject({ kind: 'text', name: 'Title', position: { anchor: 'bottom-left', space: 'safe' }, items: [{ slot: 'credit', text: 'TikTok/@pomkondeena', icon: 'camera' }] })
    expect(graphicsTextEdits(titledDocument, null)).toEqual([])
  })

  it('applies an opened image and text as one undo step', () => {
    const start = history(titled())
    const opened = edited(start, graphicsOpenEdits(start.document, { image: 'logo-1', text: { headline: THAI_TITLE }, watermark: null }), null)
    expect(opened.past).toHaveLength(1)
    expect(opened.document.layers.filter((layer) => layer.kind === 'image')).toHaveLength(1)
    expect(graphicsSlotText(opened.document, 'headline')).toBe(THAI_TITLE)
    expect(graphicsSlotText(stepGraphicsHistory(opened, 'undo')!.document, 'headline')).toBe('')
  })
})

describe('graphics layer list', () => {
  const assets = [
    { id: 'vid-1', artifactId: 'video-1', label: 'red light', type: 'video', status: 'ready', mediaUrl: '/v.mp4' },
    { id: 'img-1', artifactId: 'logo-1', label: 'Logo', type: 'image', status: 'ready', mediaUrl: '/l.png' },
    { id: 'img-2', artifactId: 'badge-1', label: 'Badge', type: 'image', status: 'ready', mediaUrl: '/b.png' },
  ]

  it('offers the image cells of the book once each, in grid order', () => {
    const mentions = [{ artifactId: 'video-1', cellAddress: 'a1' }, { artifactId: 'badge-1', cellAddress: 'a2' }, { artifactId: 'logo-1', cellAddress: 'b2' }, { artifactId: 'badge-1', cellAddress: 'c3' }]
    expect(graphicsImageChoices(assets, mentions)).toEqual([
      { artifactId: 'badge-1', address: 'a2', label: 'Badge' },
      { artifactId: 'logo-1', address: 'b2', label: 'Logo' },
    ])
  })

  it('adds each kind of layer under the id it predicts, a shade at the bottom and others on top', () => {
    const document = titled()
    const read = parseGraphicsRead(wire())
    for (const kind of ['text', 'qr', 'scrim'] as const) {
      const added = graphicsAddLayer(document, kind, { profileUrl: read.fill.profile_url })!
      const next = apply(document, [added.edit])
      const index = next.layers.findIndex((layer) => layer.id === added.layerId)
      expect(next.layers[index]?.kind).toBe(kind)
      expect(index).toBe(kind === 'scrim' ? 0 : next.layers.length - 1)
    }
    const qr = apply(document, [graphicsAddLayer(document, 'qr', { profileUrl: 'https://www.tiktok.com/@jtbkk' })!.edit]).layers.at(-1)
    expect(qr).toMatchObject({ kind: 'qr', slot: 'profile', url: 'https://www.tiktok.com/@jtbkk' })
    expect(apply(document, [graphicsAddLayer(document, 'qr', { profileUrl: 'not a link' })!.edit]).layers.at(-1)).toMatchObject({ url: '' })
    const image = graphicsAddLayer(document, 'image', { image: { artifactId: 'logo-1', address: 'b2', label: 'Logo' } })!
    expect(apply(document, [image.edit]).layers.at(-1)).toMatchObject({ id: image.layerId, kind: 'image', name: 'Logo', artifactId: 'logo-1', position: { anchor: 'top-left', space: 'safe' } })
    expect(graphicsAddLayer(document, 'image')).toBeNull()
  })

  it('renames, hides, reorders, duplicates and deletes layers, each as one undo step', () => {
    const start = history(titled())
    const [shade, title, handle] = start.document.layers
    const renamed = edited(start, [{ op: 'set_layer', layer_id: title.id, layer: { name: 'Big title' } }], null)
    const hidden = edited(renamed, [{ op: 'set_layer', layer_id: handle.id, layer: { visible: false } }], null)
    const moved = edited(hidden, [{ op: 'move_layer', layer_id: shade.id, index: 1 }], null)
    expect(moved.document.layers.map((layer) => layer.id)).toEqual([title.id, shade.id, handle.id])
    const copyId = graphicsNextLayerId(moved.document)
    const duplicated = edited(moved, [{ op: 'duplicate_layer', layer_id: title.id }], null)
    expect(duplicated.document.layers[1]).toMatchObject({ id: copyId, name: 'Big title copy' })
    expect(graphicsSelectionAfterRemove(duplicated.document, copyId)).toBe(title.id)
    expect(graphicsSelectionAfterRemove(duplicated.document, title.id)).toBe(copyId)
    const removed = edited(duplicated, [{ op: 'remove_layer', layer_id: title.id }], null)
    expect(removed.document.layers.map((layer) => layer.id)).toEqual([copyId, shade.id, handle.id])
    expect(removed.document.layers.find((layer) => layer.id === handle.id)?.visible).toBe(false)
    expect(removed.past).toHaveLength(5)
    expect(stepGraphicsHistory(removed, 'undo')!.document).toEqual(duplicated.document)
    expect(graphicsSelectionAfterRemove(removed.document, 'l99')).toBeNull()
  })

  it('summarizes each row for the list', () => {
    const document = graphicsDocumentFromLayers([
      { kind: 'text', items: [{ text: '', slot: 'headline' }, { text: '', slot: 'secondary' }] },
      { kind: 'text', items: [{ text: 'How can you look\nthis cool while waiting at a red light?' }] },
      { kind: 'image', artifactId: 'logo' },
      { kind: 'image', artifactId: 'gone' },
      { kind: 'qr', url: 'https://example.com/a', slot: null },
      { kind: 'qr' },
      { kind: 'scrim', edge: 'top' },
    ])
    const images = parseGraphicsRead(wire()).images
    expect(document.layers.map((layer) => graphicsLayerSummary(layer, images))).toEqual([
      'Empty headline, second line',
      'How can you look this cool whil…',
      'logo',
      'Image not loaded yet',
      'https://example.com/a',
      'Profile link',
      'Top shade',
    ])
    expect(graphicsLayerSummary(document.layers[2]!, images, [{ artifactId: 'logo', address: 'b2', label: 'logo' }])).toBe('@b2')
    expect(graphicsPercent(0.045)).toBe('4.5%')
    expect(graphicsPercent(1)).toBe('100%')
  })

  it('rebuilds the reference frame from the list and inspector without dragging', () => {
    let document = graphicsDocumentFromLayers([])
    const step = (edits: GraphicsEdit[]) => {
      document = apply(document, edits)
    }
    step([graphicsAddLayer(document, 'scrim')!.edit])
    const text = graphicsAddLayer(document, 'text')!
    step([text.edit])
    const block = document.layers.find((layer) => layer.id === text.layerId)
    if (block?.kind !== 'text') throw new Error('expected the added text layer')
    const [headline] = block.items
    step([
      { op: 'set_position', layer_id: text.layerId, position: { anchor: 'bottom-left', x: 0, y: 1 } },
      { op: 'set_text_block', layer_id: text.layerId, block: { align: 'left' } },
      { op: 'set_item', layer_id: text.layerId, item_id: headline.id, item: { text: 'How can you look this cool while waiting at a red light?', slot: 'headline', accent: 'brush', maxLines: 3 } },
      { op: 'add_item', layer_id: text.layerId, item: { text: THAI_TITLE, slot: 'secondary', size: 0.045 } },
      { op: 'add_item', layer_id: text.layerId, item: { text: 'TikTok/@pomkondeena', slot: 'credit', icon: 'camera', size: 0.03 } },
    ])
    step([graphicsAddLayer(document, 'image', { image: { artifactId: 'logo-1', address: 'b2', label: 'Logo' } })!.edit])
    expect(document.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'image'])
    expect(document.layers[0]).toMatchObject({ edge: 'bottom' })
    expect(document.layers[1]).toMatchObject({
      position: { anchor: 'bottom-left', x: 0, y: 1, space: 'safe' },
      align: 'left',
      items: [
        { slot: 'headline', accent: 'brush' },
        { slot: 'secondary', text: THAI_TITLE },
        { slot: 'credit', icon: 'camera' },
      ],
    })
    expect(document.layers[2]).toMatchObject({ artifactId: 'logo-1', position: { anchor: 'top-left', x: 0, y: 0, space: 'safe' } })
  })
})

function profileQr(layer: ReturnType<typeof watermarkLayerInputs>[number] | undefined): GraphicsQrLayerInput {
  if (layer?.kind !== 'qr') throw new Error('expected the profile QR layer')
  return layer
}

describe('graphics watermark mode', () => {
  const frame = { width: 1080, height: 1920 }
  const xProfile = { ...watermarkProfileFor('x', null), handle: 'justinwtanner', profileUrl: 'https://x.com/justinwtanner' }
  const tiktokLook = platformWatermarkDocument(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: false })
  const xLook = platformWatermarkDocument(xProfile, frame, { includeQr: false })
  const tiktokQr = profileQr(watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: true, includeHandle: false })[0])
  const watermarkRead = (platform: 'tiktok' | 'x', overrides: Record<string, unknown> = {}) => read({
    document: platform === 'tiktok' ? tiktokLook : xLook,
    fill: platform === 'tiktok'
      ? { handle: 'jtbkk', profile_url: 'https://www.tiktok.com/@jtbkk', credit: null }
      : { handle: 'justinwtanner', profile_url: 'https://x.com/justinwtanner', credit: null },
    watermark: { platform, template_id: null, template_name: null, look: platform === 'tiktok' ? tiktokLook : xLook, qr: tiktokQr },
    ...overrides,
  })

  it('opens /watermark on TikTok and a routed plan on its platform with the handle and QR it asks for', () => {
    expect(graphicsWatermarkTarget()).toEqual({ platform: 'tiktok', handle: null, includeQr: null })
    expect(graphicsWatermarkTarget({ asset_id: 'video-1', platform: 'x', handle: ' @justinwtanner ', include_qr: true, position: 'top-left' }))
      .toEqual({ platform: 'x', handle: '@justinwtanner', includeQr: true })
    expect(graphicsWatermarkTarget({ platform: 'instagram', handle: 4, include_qr: 'yes' })).toEqual({ platform: 'tiktok', handle: null, includeQr: null })
    const assets = [{ id: 'vid-1', artifactId: 'video-1', label: 'red light', type: 'video', status: 'ready', mediaUrl: '/files/b/video-1/original.mp4' }]
    expect(graphicsEditorTarget({ reference: '@a1', image: undefined, watermark: graphicsWatermarkTarget(), assets, mentions: [{ artifactId: 'video-1', cellAddress: 'a1' }], notebookId: null }))
      .toMatchObject({ ok: true, target: { artifactId: 'video-1', watermark: { platform: 'tiktok', handle: null, includeQr: null } } })
  })

  it('parses the watermark of a get and leaves it out of graphics mode', () => {
    const parsed = watermarkRead('tiktok', { watermark: { platform: 'tiktok', template_id: 'saved-1', template_name: 'Brand', look: tiktokLook, qr: tiktokQr } })
    expect(parsed.watermark).toMatchObject({ platform: 'tiktok', template_id: 'saved-1', template_name: 'Brand', qr: { kind: 'qr', slot: 'profile', style: 'tile' } })
    expect(parsed.watermark?.look).toEqual(tiktokLook)
    expect(read().watermark).toBeNull()
    expect(watermarkRead('tiktok', { watermark: { platform: 'tiktok', template_id: null, template_name: null, look: tiktokLook, qr: { kind: 'qr', size: 9 } } }).watermark?.qr).toBeNull()
    expect(() => watermarkRead('tiktok', { watermark: { platform: 'tiktok', template_id: null, template_name: null, look: { version: 2 }, qr: null } })).toThrow()
  })

  it('applies the handle and QR a routed plan asks for as one undo step', () => {
    const parsed = watermarkRead('tiktok')
    const start = history(tiktokLook)
    const opened = edited(start, graphicsOpenEdits(tiktokLook, { image: null, text: null, watermark: { platform: 'tiktok', handle: '@creator.name', includeQr: true } }, parsed), null)
    expect(opened.past).toHaveLength(1)
    expect(graphicsSlotText(opened.document, 'handle')).toBe('creator.name')
    expect(opened.document.layers.find((layer) => layer.kind === 'qr')).toMatchObject({ slot: 'profile', url: 'https://www.tiktok.com/@jtbkk', style: 'tile', opacity: LIGHTNING_WATERMARK_PROFILE.qrOpacity })
    const withoutQr = graphicsOpenEdits(opened.document, { image: null, text: null, watermark: { platform: 'tiktok', handle: null, includeQr: false } }, parsed)
    expect(withoutQr).toEqual([{ op: 'remove_layer', layer_id: opened.document.layers.find((layer) => layer.kind === 'qr')?.id }])
    expect(graphicsOpenEdits(tiktokLook, { image: null, text: null, watermark: { platform: 'tiktok', handle: 'jtbkk', includeQr: null } }, parsed)).toEqual([])
    expect(graphicsOpenEdits(tiktokLook, { image: null, text: null, watermark: null }, parsed)).toEqual([])
  })

  it('draws the shade only behind a typed title and blocks a watermark with nothing to burn', () => {
    expect(graphicsDrawnDocument(tiktokLook, true).layers.map((layer) => layer.kind)).toEqual(['text', 'text'])
    expect(graphicsDrawnDocument(tiktokLook, false)).toBe(tiktokLook)
    const titledLook = apply(tiktokLook, [{ op: 'set_slot_text', slot: 'headline', text: THAI_TITLE }])
    expect(graphicsDrawnDocument(titledLook, true).layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    const shadeOnly = graphicsDocumentFromLayers([{ kind: 'scrim', edge: 'bottom' }])
    expect(graphicsRenderBlocker(shadeOnly, 8, false, true)).toBe('Add the handle, a title, an image or a QR code to render.')
    expect(graphicsRenderBlocker(shadeOnly, 8, false)).toBeNull()
    expect(graphicsRenderBlocker(tiktokLook, 8, false, true)).toBeNull()
  })

  it('switches platform to that platform\'s watermark, keeping the typed title', () => {
    const draft = apply(tiktokLook, [{ op: 'set_slot_text', slot: 'headline', text: THAI_TITLE }])
    const edits = graphicsWatermarkSwitchEdits(draft, watermarkRead('x'))
    expect(edits.map((edit) => edit.op)).toEqual(['apply_template', 'set_slot_text'])
    const switched = apply(draft, edits)
    expect(graphicsSlotText(switched, 'handle')).toBe('justinwtanner')
    expect(graphicsSlotText(switched, 'headline')).toBeNull()
    const back = apply(switched, graphicsWatermarkSwitchEdits(switched, watermarkRead('tiktok')))
    expect(graphicsSlotText(back, 'handle')).toBe('jtbkk')
    expect(back.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    expect(graphicsWatermarkSwitchEdits(draft, read())).toEqual([])
  })

  it('adds the profile QR, and says what rendering, saving and resetting the watermark did', () => {
    const added = graphicsAddLayer(tiktokLook, 'qr', { profileUrl: 'https://www.tiktok.com/@jtbkk', qr: tiktokQr })
    expect(added?.edit).toEqual({ op: 'add_layer', layer: tiktokQr })
    const watermark = { platform: 'tiktok' as const, handle: null, includeQr: null }
    expect(graphicsRenderQueuedMessage('replace', { label: 'red light', address: 'a1', watermark })).toBe('Burning the watermark into @a1. The video updates in place when the render finishes.')
    expect(graphicsRenderQueuedMessage('new', { label: 'red light', address: null, watermark })).toMatch(/watermarked copy of red light/u)
    const saved = { template: { id: 'w1', name: 'TikTok watermark', updated_at: 'now' }, watermark: { platform: 'tiktok', template_id: 'w1' } }
    expect(graphicsTemplateMessage('save_watermark', saved, { platform: 'tiktok' }))
      .toBe('Saved as the default TikTok watermark (“TikTok watermark”). Goal finishing and apply_watermark burn it from now on.')
    expect(graphicsTemplateMessage('set_watermark_template', { watermark: { platform: 'x', template_id: null } }, { platform: 'x' }))
      .toBe('Goal finishing and apply_watermark burn the X profile’s watermark again.')
  })
})

describe('graphics suggestions', () => {
  it('suggests the headline and translates it for the second line, and nothing else', () => {
    expect(graphicsSuggestKind('headline')).toBe('headline')
    expect(graphicsSuggestKind('secondary')).toBe('translate')
    expect(graphicsSuggestKind('credit')).toBeNull()
    expect(graphicsSuggestKind('handle')).toBeNull()
  })

  it('parses the options of a suggest result and refuses a result without any', () => {
    const result = { asset_id: 'v1', kind: 'translate', slot: 'secondary', language: 'en', text: 'ติดไฟแดง', options: ['Red light', 'Stuck at a red light', 'Still cool'], model: 'gpt-6-astra', context: null }
    expect(parseGraphicsSuggestions(result)).toEqual({ kind: 'translate', language: 'en', options: ['Red light', 'Stuck at a red light', 'Still cool'] })
    expect(() => parseGraphicsSuggestions({ ...result, options: [] })).toThrow()
    expect(() => parseGraphicsSuggestions({ ...result, language: 'fr' })).toThrow()
  })
})

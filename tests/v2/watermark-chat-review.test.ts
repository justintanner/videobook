import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers, type GraphicsDocument } from '../../server/src/graphics/model'
import { platformWatermarkDocument } from '../../server/src/graphics/starters'
import { watermarkLayerInputs } from '../../server/src/graphics/watermark-profile'
import { LIGHTNING_WATERMARK_PROFILE, watermarkProfileFor } from '../../server/src/lightning-defaults'
import type { WatermarkPlatform } from '../../server/src/watermark-platform'
import { GraphicsSheet } from '../../src/components/videobook/graphics/GraphicsSheet'
import { GraphicsWatermark } from '../../src/components/videobook/graphics/GraphicsWatermark'
import {
  graphicsEditorTarget,
  graphicsWatermarkTarget,
  parseGraphicsRead,
  type GraphicsRead,
  type GraphicsRenderOutput,
  type GraphicsTarget,
} from '../../src/videobook/graphics-model'
import type { GraphicsEditor, GraphicsEditorState } from '../../src/videobook/useGraphicsEditor'

const FRAME = { width: 1080, height: 1920 }
const X_PROFILE = { ...watermarkProfileFor('x', null), handle: 'someone', profileUrl: 'https://example.com/profile' }
const LOOKS: Record<WatermarkPlatform, GraphicsDocument> = {
  tiktok: platformWatermarkDocument(LIGHTNING_WATERMARK_PROFILE, FRAME, { includeQr: false }),
  x: platformWatermarkDocument(X_PROFILE, FRAME, { includeQr: false }),
}
const ASSETS = [{ id: 'vid-1', artifactId: 'video-1', label: 'red light', type: 'video', status: 'ready', mediaUrl: '/files/book/video-1/proxy.mp4' }]
const MENTIONS = [{ artifactId: 'video-1', cellAddress: 'a1' }]

function watermarkRead(platform: WatermarkPlatform, overrides: { document?: GraphicsDocument; templateName?: string | null } = {}): GraphicsRead {
  const document = overrides.document ?? LOOKS[platform]
  const handle = platform === 'tiktok' ? 'jtbkk' : 'someone'
  return parseGraphicsRead({
    asset_id: 'video-1',
    address: '@a1',
    label: 'red light',
    source: { ...FRAME, duration_seconds: 12, fps: 30, source_hash: 'hash' },
    saved: false,
    revision: 'default:watermark',
    updated_at: null,
    document,
    fill: { handle, profile_url: platform === 'tiktok' ? 'https://www.tiktok.com/@jtbkk' : 'https://example.com/profile', credit: null },
    starters: [],
    images: {},
    render: null,
    burned: null,
    watermark: {
      platform,
      template_id: overrides.templateName ? 'saved-1' : null,
      template_name: overrides.templateName ?? null,
      look: LOOKS[platform],
      qr: watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, FRAME, { includeQr: true, includeHandle: false })[0],
    },
  })
}

function watermarkTarget(params: Record<string, unknown> = {}): GraphicsTarget {
  const resolved = graphicsEditorTarget({ reference: '@a1', image: undefined, watermark: graphicsWatermarkTarget(params), assets: ASSETS, mentions: MENTIONS, notebookId: 'nb' })
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.target
}

function editorFor(target: GraphicsTarget, read: GraphicsRead, output: GraphicsRenderOutput = 'replace'): GraphicsEditor {
  const state: GraphicsEditorState = {
    target,
    loading: false,
    read,
    document: read.document,
    revision: read.revision,
    save: 'saved',
    saveError: null,
    conflictRevision: null,
    error: null,
    past: [],
    future: [],
    coalesceKey: null,
    rendering: false,
    output,
    suggestions: {},
  }
  const done = async () => ({ ok: true, message: '' })
  return {
    state,
    bookId: 'book-1',
    open: () => undefined,
    close: () => undefined,
    edit: () => true,
    undo: () => undefined,
    redo: () => undefined,
    reload: async () => undefined,
    keepMine: async () => undefined,
    setOutput: () => undefined,
    render: done,
    flush: async () => true,
    saveTemplate: done,
    renameTemplate: done,
    deleteTemplate: done,
    setDefaultTemplate: done,
    copyTemplates: done,
    saveWatermark: done,
    resetWatermark: done,
    setPlatform: async () => undefined,
    suggest: async () => undefined,
    dismissSuggestions: () => undefined,
    findClearSpot: done,
  }
}

function renderSheet(editor: GraphicsEditor): string {
  return renderToStaticMarkup(createElement(GraphicsSheet, {
    editor,
    assets: ASSETS,
    mentions: MENTIONS,
    books: [],
    applyFormId: 'command-composer-form',
    onClose: () => undefined,
    onOpenSource: () => undefined,
  }))
}

function renderPanel(editor: GraphicsEditor, platform: WatermarkPlatform): string {
  return renderToStaticMarkup(createElement(GraphicsWatermark, { editor, read: editor.state.read!, platform, disabled: false }))
}

describe('watermark in the graphics editor', () => {
  it('opens /watermark as the graphics editor in watermark mode that burns into the video in place', () => {
    const editor = editorFor(watermarkTarget(), watermarkRead('tiktok'))
    const html = renderSheet(editor)
    expect(html).toContain('confirm-sheet confirm-sheet-graphics')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Watermark editor"')
    expect(html).toContain('>WATERMARK<')
    expect(html).toContain('Watermark · red light')
    expect(html).toContain('@a1')
    expect(html).toContain('Replaces the video · earlier version kept')
    expect(html).toContain('form="command-composer-form"')
    expect(html).toContain('class="confirm-sheet-apply">Render <kbd>↵</kbd>')
    expect(html).toContain('aria-pressed="true">Replace video</button>')
    expect(html).toContain('aria-pressed="false">New video</button>')
    expect(html).not.toContain('confirm-sheet-foot-blocking')
    expect(html).not.toContain('Rebuilds playable proxy')
  })

  it('offers the platform switch and saving the look as the default watermark', () => {
    const tiktok = renderPanel(editorFor(watermarkTarget(), watermarkRead('tiktok')), 'tiktok')
    expect(tiktok).toContain('aria-label="Watermark"')
    expect(tiktok).toContain('aria-label="Watermark platform"')
    expect(tiktok).toContain('aria-pressed="true">TikTok</button>')
    expect(tiktok).toContain('aria-pressed="false">X</button>')
    expect(tiktok).toContain('>Save as default watermark</button>')
    expect(tiktok).toContain('Goal finishing and apply_watermark burn the TikTok profile’s watermark.')
    expect(tiktok).not.toContain('Use the profile’s look')

    const x = renderPanel(editorFor(watermarkTarget({ platform: 'x' }), watermarkRead('x', { templateName: 'Brand' })), 'x')
    expect(x).toContain('aria-pressed="true">X</button>')
    expect(x).toContain('Goal finishing and apply_watermark burn your saved X watermark, “Brand”.')
    expect(x).toContain('>Use the profile’s look</button>')
  })

  it('keeps the TikTok look on the handle, an empty Thai title and an English line with no QR', () => {
    const read = watermarkRead('tiktok')
    expect(read.document.layers.map((layer) => layer.kind)).toEqual(['scrim', 'text', 'text'])
    const items = read.document.layers.flatMap((layer) => (layer.kind === 'text' ? layer.items : []))
    expect(items.map((item) => [item.slot, item.text, item.icon])).toEqual([['headline', '', null], ['secondary', '', null], ['handle', 'jtbkk', 'tiktok']])
    const x = watermarkRead('x')
    expect(x.document.layers.flatMap((layer) => (layer.kind === 'text' ? layer.items : [])).map((item) => [item.slot, item.text, item.icon])).toEqual([['handle', 'someone', 'x']])
  })

  it('gives the footer back the moment the watermark would burn nothing', () => {
    const shadeOnly = graphicsDocumentFromLayers([{ kind: 'scrim', edge: 'bottom' }])
    const html = renderSheet(editorFor(watermarkTarget(), watermarkRead('tiktok', { document: shadeOnly })))
    expect(html).toContain('confirm-sheet-foot confirm-sheet-foot-blocking')
    expect(html).toContain('<strong>Can’t apply — </strong>')
    expect(html).toContain('Add the handle, a title, an image or a QR code to render.')
    expect(html).toContain('class="confirm-sheet-apply" disabled=""')
  })

  it('keeps the graphics editor itself for /osg', () => {
    const resolved = graphicsEditorTarget({ reference: '@a1', image: undefined, assets: ASSETS, mentions: MENTIONS, notebookId: 'nb' })
    if (!resolved.ok) throw new Error(resolved.message)
    const html = renderSheet(editorFor(resolved.target, { ...watermarkRead('tiktok'), watermark: null }, 'new'))
    expect(html).toContain('aria-label="Graphics editor"')
    expect(html).toContain('>GRAPHICS<')
    expect(html).toContain('New video cell · source kept')
  })
})

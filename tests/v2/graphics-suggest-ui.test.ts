import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers, type GraphicsDocument } from '../../server/src/graphics/model'
import { GraphicsQuickFields } from '../../src/components/videobook/graphics/GraphicsQuickFields'
import { GraphicsSuggestionTray } from '../../src/components/videobook/graphics/GraphicsSuggestions'
import { parseGraphicsRead, type GraphicsRead, type GraphicsSuggestionLists } from '../../src/videobook/graphics-model'

const THAI_TITLE = 'ติดไฟแดงยังไงให้เท่ได้ขนาดนี้'

function look(headline: string, secondary = ''): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: 'text', items: [{ slot: 'headline', text: headline }, { slot: 'secondary', text: secondary }, { slot: 'credit', text: '' }] },
  ])
}

function readOf(document: GraphicsDocument): GraphicsRead {
  return parseGraphicsRead({
    asset_id: 'video-1',
    address: '@a1',
    label: 'red light',
    source: { width: 1080, height: 1920, duration_seconds: 12, fps: 30, source_hash: 'hash' },
    saved: true,
    revision: 'r1',
    updated_at: null,
    document,
    fill: { handle: 'jtbkk', profile_url: null, credit: null },
    starters: [],
    images: {},
    render: null,
    burned: null,
    watermark: null,
  })
}

function fields(document: GraphicsDocument, suggestions: GraphicsSuggestionLists = {}, disabled = false): string {
  return renderToStaticMarkup(createElement(GraphicsQuickFields, {
    document,
    read: readOf(document),
    disabled,
    suggestions,
    onEdit: () => true,
    onSuggest: () => undefined,
  }))
}

function tray(document: GraphicsDocument, suggestions: GraphicsSuggestionLists = {}, disabled = false): string {
  return renderToStaticMarkup(createElement(GraphicsSuggestionTray, {
    document,
    suggestions,
    disabled,
    onPick: () => undefined,
    onDismiss: () => undefined,
  }))
}

function render(document: GraphicsDocument, suggestions: GraphicsSuggestionLists = {}, disabled = false): string {
  return `${fields(document, suggestions, disabled)}${tray(document, suggestions, disabled)}`
}

function count(html: string, text: string): number {
  return html.split(text).length - 1
}

describe('suggested text in the graphics editor', () => {
  it('offers Suggest on the headline, Thai first, and Translate on the second line once there is a headline', () => {
    const empty = render(look(''))
    expect(empty).toContain('aria-label="Headline language"')
    expect(empty).toContain('aria-pressed="true">Thai</button>')
    expect(empty).toContain('aria-pressed="false">English</button>')
    expect(count(empty, 'Suggest</button>')).toBe(1)
    expect(empty).toMatch(/<button type="button" class="graphics-assist" disabled="" title="Type or pick a headline first\.">.*Translate to English<\/button>/u)
    expect(empty).not.toContain('suggestions"')

    const thai = render(look(THAI_TITLE))
    expect(thai).toMatch(/<button type="button" class="graphics-assist" title="Translate the headline for this line\. Uses one paid model call; nothing changes until you pick an option\.">.*Translate to English<\/button>/u)
    expect(render(look('How can you look this cool?'))).toContain('Translate to Thai</button>')
    expect(count(thai, 'Translate to')).toBe(1)
  })

  it('offers nothing for a look without a headline or second line, and nothing while the editor is locked', () => {
    const handleOnly = render(graphicsDocumentFromLayers([{ kind: 'text', items: [{ slot: 'handle', text: 'jtbkk' }] }]))
    expect(handleOnly).not.toContain('Suggest</button>')
    expect(handleOnly).not.toContain('Translate to')
    const locked = render(look(THAI_TITLE), {}, true)
    expect(locked).toMatch(/class="graphics-assist" disabled=""[^>]*>.*Suggest<\/button>/u)
    expect(locked).toMatch(/class="graphics-assist" disabled=""[^>]*>.*Translate to English<\/button>/u)
  })

  it('lists the options to pick from, marks the one in the field and applies nothing by itself', () => {
    const html = render(look('ร่มชมพูกลางไฟแดง'), {
      headline: { requestId: 'r1', kind: 'headline', language: 'th', status: 'ready', options: ['ไฟแดงนี้ของเรา', 'ร่มชมพูกลางไฟแดง'], message: null },
      secondary: { requestId: 'r2', kind: 'translate', language: 'en', status: 'ready', options: ['A pink umbrella at the red light'], message: null },
    })
    expect(html).toContain('role="group" aria-label="Headline suggestions" aria-busy="false"')
    expect(html).toContain('<span role="status">Pick a headline in Thai</span>')
    expect(html).toContain('aria-pressed="false">ไฟแดงนี้ของเรา</button>')
    expect(html).toContain('aria-pressed="true">ร่มชมพูกลางไฟแดง</button>')
    expect(html).toContain('aria-label="Hide headline suggestions"')
    expect(html).toContain('<span role="status">Pick a line in English</span>')
  })

  it('shows the request while it runs and the reason when it fails', () => {
    const html = render(look(THAI_TITLE), {
      headline: { requestId: 'r1', kind: 'headline', language: 'en', status: 'loading', options: [], message: null },
      secondary: { requestId: 'r2', kind: 'translate', language: 'en', status: 'error', options: [], message: 'Suggestions need an OpenAI API key, and OPENAI_API_KEY is not set.' },
    })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<span role="status">Writing headlines in English…</span>')
    expect(html).toMatch(/class="graphics-assist" disabled=""[^>]*>.*Suggesting…<\/button>/u)
    expect(html).toContain('<span role="status">No translation</span>')
    expect(html).toContain('<p class="graphics-suggestions-error" role="alert">Suggestions need an OpenAI API key, and OPENAI_API_KEY is not set.</p>')
  })

  it('lists the options beside the fields, so an open list never pushes the fields down', () => {
    const lists: GraphicsSuggestionLists = {
      headline: { requestId: 'r1', kind: 'headline', language: 'th', status: 'ready', options: ['ไฟแดงนี้ของเรา'], message: null },
    }
    expect(fields(look(THAI_TITLE), lists)).not.toContain('suggestions"')
    expect(tray(look(THAI_TITLE), lists)).toMatch(/^<div class="graphics-suggestion-tray"><div class="graphics-suggestions" role="group" aria-label="Headline suggestions"/u)
    expect(tray(look(THAI_TITLE))).toBe('')
  })

  it('edits the handle the look draws from the Credit field when the look has no credit line', () => {
    const handled = graphicsDocumentFromLayers([
      { kind: 'text', items: [{ slot: 'handle', text: 'jtbkk', icon: 'tiktok' }, { slot: 'headline', text: '' }, { slot: 'secondary', text: '' }] },
    ])
    const html = fields(handled)
    expect(html).toMatch(/<label for="([^"]+)">Credit<\/label>.*<div class="graphics-field-input" data-icon="true"><svg class="graphics-field-icon"[^>]*>.*<\/svg><input id="\1" placeholder="Your handle" maxLength="280" data-slot="handle" type="text" value="jtbkk"\/>/u)
    expect(html).not.toContain('No credit in this look')
    expect(fields(look(''))).toMatch(/placeholder="Platform\/@handle"[^>]*data-slot="credit"/u)
    const neither = fields(graphicsDocumentFromLayers([{ kind: 'text', items: [{ slot: 'headline', text: '' }] }]))
    expect(neither).toMatch(/disabled=""[^>]*placeholder="No credit in this look"[^>]*data-slot="credit"|placeholder="No credit in this look"[^>]*disabled=""[^>]*data-slot="credit"/u)
    expect(neither).toContain('Apply a template with a credit to add one.')
  })

  it('offers the saved handle beside the Credit field when the look carries another one', () => {
    const other = graphicsDocumentFromLayers([{ kind: 'text', items: [{ slot: 'handle', text: 'someone' }] }])
    expect(fields(other)).toMatch(/<button type="button" class="graphics-suggestion">Use jtbkk<\/button>/u)
    expect(fields(graphicsDocumentFromLayers([{ kind: 'text', items: [{ slot: 'handle', text: 'jtbkk' }] }]))).not.toContain('Use jtbkk')
  })
})

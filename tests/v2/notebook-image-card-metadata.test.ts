import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageCardMetadataBadges } from '../../src/App'

describe('notebook image card metadata', () => {
  it('renders compact dimensions, aspect ratio, and generator badges', () => {
    const prompt = 'A detailed prompt that should remain accessible without covering the image'
    const html = renderToStaticMarkup(createElement(ImageCardMetadataBadges, {
      width: 768,
      height: 1344,
      tool: 'Nano Banana Pro Text to Image',
      model: 'googleflow/image/nano-banana-pro',
      prompt,
    }))

    expect(html).toContain('class="cell-image-metadata"')
    expect(html).toContain('role="group"')
    expect(html).toContain('Dimensions 768×1344')
    expect(html).toContain('Aspect ratio 9:16')
    expect(html).toContain('Generator Nano Banana Pro T2I')
    expect(html).toContain('>768×1344</span>')
    expect(html).toContain('>9:16</span>')
    expect(html).toContain('>Nano Banana Pro T2I</span>')
    expect(html.match(new RegExp(prompt, 'g'))).toHaveLength(1)
  })

  it('omits the badge cluster when no concise metadata is available', () => {
    const html = renderToStaticMarkup(createElement(ImageCardMetadataBadges, {
      width: null,
      height: null,
      tool: null,
      model: null,
      prompt: 'Prompt remains available from the image card title',
    }))

    expect(html).toBe('')
  })

  it('falls back to an abbreviated model badge when no tool title is available', () => {
    const html = renderToStaticMarkup(createElement(ImageCardMetadataBadges, {
      width: null,
      height: null,
      tool: null,
      model: 'seedream/5-pro-image-to-image',
      prompt: null,
    }))

    expect(html).toContain('Generator seedream/5-pro-I2I')
    expect(html).toContain('>seedream/5-pro-I2I</span>')
  })
})

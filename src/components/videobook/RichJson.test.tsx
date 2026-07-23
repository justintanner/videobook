import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RichJson } from './RichJson'

describe('RichJson', () => {
  it('formats action source values with semantic token classes', () => {
    const html = renderToStaticMarkup(
      <RichJson value={{
        title: 'Cat dance',
        attempt: 2,
        published: true,
        failure: null,
      }} />,
    )

    expect(html).toContain('class="json-key"')
    expect(html).toContain('class="json-string"')
    expect(html).toContain('class="json-number"')
    expect(html).toContain('class="json-boolean"')
    expect(html).toContain('class="json-null"')
    expect(html).toContain('class="json-punctuation"')
  })

  it('escapes source text before rendering it', () => {
    const html = renderToStaticMarkup(
      <RichJson value={{ prompt: '<script>render()</script>' }} />,
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

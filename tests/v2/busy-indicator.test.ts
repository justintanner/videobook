import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BusyIndicator } from '../../src/components/videobook/BusyIndicator'

const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')

describe('BusyIndicator', () => {
  it.each([12, 22])('renders an aria-hidden activity signal at %ipx', (size) => {
    const html = renderToStaticMarkup(createElement(BusyIndicator, { size }))

    expect(html).toContain('class="busy-indicator"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('lucide-activity')
    expect(html).toContain(`width="${size}"`)
    expect(html).toContain(`height="${size}"`)
    expect(html).not.toContain('lucide-loader-circle')
  })

  it('uses a non-rotating signal animation with a static reduced-motion state', () => {
    expect(css).toContain('animation: busy-signal-beat 1.15s ease-in-out infinite')
    expect(css).toContain('@keyframes busy-signal-beat')
    expect(css).not.toContain('@keyframes spin')
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.busy-indicator > svg \{[\s\S]*?animation: none !important/,
    )
  })
})

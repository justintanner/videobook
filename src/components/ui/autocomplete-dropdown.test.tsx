import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AutocompleteDropdown, type AutocompleteItem } from './AutocompleteDropdown'

function mention(
  label: string,
  overrides: Partial<AutocompleteItem> = {},
): AutocompleteItem {
  return {
    type: 'mention',
    value: label,
    label,
    description: 'VIDEO · 1440×810 · 0:06',
    colorScheme: 'amber',
    ...overrides,
  }
}

function render(items: AutocompleteItem[], selectedIndex = 0): string {
  return renderToStaticMarkup(
    <AutocompleteDropdown
      items={items}
      selectedIndex={selectedIndex}
      onSelect={() => {}}
      onHover={() => {}}
    />,
  )
}

describe('AutocompleteDropdown', () => {
  it('gives a square holding media one line: poster, slug, label, facts', () => {
    const html = render([mention('@ad3', {
      caption: 'rooftop wide',
      thumbnailSrc: 'https://example.invalid/poster.jpg',
      mediaKind: 'video',
    })])

    expect(html).toContain('src="https://example.invalid/poster.jpg"')
    expect(html).toContain('@ad3')
    expect(html).toContain('rooftop wide')
    expect(html).toContain('VIDEO · 1440×810 · 0:06')
    // One row, one line: 40px tall, nothing wrapping.
    expect(html).toContain('h-10')
    expect(html.match(/data-option-index=/gu)).toHaveLength(1)
  })

  it('draws a kind glyph when the cell has no poster frame', () => {
    const withPoster = render([mention('@ad3', { thumbnailSrc: 'https://x.invalid/a.jpg', mediaKind: 'video' })])
    const withoutPoster = render([mention('@ad3', { mediaKind: 'audio' })])

    expect(withPoster).toContain('<img')
    expect(withoutPoster).not.toContain('<img')
    expect(withoutPoster).toContain('<svg')
  })

  it('collapses the empty squares into one chip strip', () => {
    const html = render([
      mention('@ad3', { caption: 'rooftop wide', mediaKind: 'video' }),
      mention('@ad1', { description: 'Empty grid square', empty: true }),
      mention('@ad2', { description: 'Empty grid square', empty: true }),
      mention('@ad4', { description: 'Empty grid square', empty: true }),
    ])

    // Every square is still reachable…
    expect(html.match(/data-option-index=/gu)).toHaveLength(4)
    // …but the phrase that used to fill the menu appears once, as a tooltip.
    expect(html.match(/Empty grid square/gu)).toHaveLength(3)
    expect(html).toContain('>EMPTY<')
    expect(html.match(/class="w-full h-10/gu)).toHaveLength(1)
  })

  it('keeps the option indices of the original list across the split', () => {
    const html = render([
      mention('@ad3', { mediaKind: 'video' }),
      mention('@ad1', { empty: true }),
      mention('@ad5', { mediaKind: 'image' }),
    ])

    // The empty chip keeps index 1 even though it renders after both rows.
    expect(html.indexOf('data-option-index="2"')).toBeLessThan(
      html.indexOf('data-option-index="1"'),
    )
  })

  it('marks the cursor row and only the cursor row', () => {
    const html = render([
      mention('@ad3', { mediaKind: 'video' }),
      mention('@ad5', { mediaKind: 'image' }),
    ], 1)

    expect(html.match(/inset_2px_0_0/gu)).toHaveLength(1)
  })

  it('leaves a command row reading as its description', () => {
    const html = render([{
      type: 'command',
      value: '/render',
      label: '/render',
      description: 'Render the sequence',
      colorScheme: 'cyan',
    }])

    expect(html).toContain('Render the sequence')
    expect(html).not.toContain('>EMPTY<')
  })
})

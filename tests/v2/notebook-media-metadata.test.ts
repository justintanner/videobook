import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotebookMediaMetadata } from '../../src/components/videobook/NotebookMediaMetadata'

describe('notebook media metadata', () => {
  it('renders dimensions and formatted duration for video overlays', () => {
    const html = renderToStaticMarkup(createElement(NotebookMediaMetadata, {
      className: 'cell-media-metadata',
      width: 576,
      height: 1024,
      durationSeconds: 8.25,
    }))

    expect(html).toContain('class="notebook-media-metadata cell-media-metadata"')
    expect(html).toContain('<span>576×1024</span>')
    expect(html).toContain('dateTime="PT8.25S"')
    expect(html).toContain('aria-label="Duration 0:08.25"')
  })

  it('omits invalid metadata', () => {
    const html = renderToStaticMarkup(createElement(NotebookMediaMetadata, {
      className: 'cell-media-metadata',
      width: 0,
      height: 1024,
      durationSeconds: Number.NaN,
    }))

    expect(html).toBe('')
  })
})

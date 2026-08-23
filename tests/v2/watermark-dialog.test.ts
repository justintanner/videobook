import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  WatermarkDialog,
  type WatermarkDialogState,
} from '../../src/components/videobook/WatermarkDialog'

function renderWatermark(overrides: Partial<WatermarkDialogState> = {}): string {
  return renderToStaticMarkup(createElement(WatermarkDialog, {
    state: {
      assetId: 'vid-1',
      targetLabel: '@a1',
      mediaUrl: '/files/book/vid-1/proxy.mp4',
      thumbnailUrl: '/files/book/vid-1/original.jpg',
      width: 1920,
      height: 1080,
      durationSeconds: 12,
      handle: 'someone',
      url: 'https://example.com/profile',
      includeQr: true,
      position: 'middle-center',
      startSeconds: 0,
      endSeconds: 8,
      saveDefault: false,
      recent: ['someone'],
      loadingConfig: false,
      submitting: false,
      error: null,
      ...overrides,
    },
    onChange: () => undefined,
    onMediaMetadata: () => undefined,
    onSubmit: () => undefined,
    onClose: () => undefined,
  }))
}

describe('watermark dialog', () => {
  it('renders a live video review with placement and timing controls', () => {
    const html = renderWatermark()
    expect(html).toContain('src="/files/book/vid-1/proxy.mp4"')
    expect(html).toContain('controls')
    expect(html).toContain('watermark-preview-badge with-qr')
    expect(html).toContain('lucide-qr-code')
    expect(html).toContain('aria-label="Middle center" aria-pressed="true"')
    expect(html.match(/type="number"/g)).toHaveLength(2)
    expect(html).toContain('0.0s → 8.0s')
    expect(html).toContain('Set from playhead')
  })

  it('previews and configures a handle-only watermark', () => {
    const html = renderWatermark({
      includeQr: false,
      position: 'top-left',
      endSeconds: null,
    })
    expect(html).toContain('watermark-preview-badge handle-only')
    expect(html).toContain('Handle only')
    expect(html).not.toContain('lucide-qr-code')
    expect(html).not.toContain('QR link')
    expect(html).toContain('aria-label="Top left" aria-pressed="true"')
  })
})

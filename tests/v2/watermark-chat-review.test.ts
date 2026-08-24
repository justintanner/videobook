import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  WatermarkChatReview,
  type WatermarkReviewState,
} from '../../src/components/videobook/WatermarkChatReview'

function renderWatermark(overrides: Partial<WatermarkReviewState> = {}): string {
  return renderToStaticMarkup(createElement(WatermarkChatReview, {
    applyFormId: 'command-composer-form',
    busy: false,
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
      handleVerticalPercent: 33,
      startSeconds: 0,
      endSeconds: 8,
      saveDefault: false,
      recent: ['someone'],
      loadingConfig: false,
      error: null,
      ...overrides,
    },
    onChange: () => undefined,
    onMediaMetadata: () => undefined,
    onCancel: () => undefined,
  }))
}

describe('watermark chat review', () => {
  it('renders one composer review with live placement and timing controls', () => {
    const html = renderWatermark()
    expect(html).toContain('command-plan-drawer watermark-chat-review')
    expect(html).toContain('aria-label="Watermark review"')
    expect(html).toContain('WATERMARK · CHAT')
    expect(html).toContain('form="command-composer-form"')
    expect(html).toContain('src="/files/book/vid-1/proxy.mp4"')
    expect(html).toContain('controls')
    expect(html).toContain('watermark-preview-overlay watermark-preview-qr')
    expect(html).toContain('watermark-preview-overlay watermark-preview-handle')
    expect(html).toContain('top:33%;left:50%;transform:translate(-50%, -50%)')
    const qrPath = html.match(/class="watermark-preview-qr-modules"[^>]*>\s*<path d="([^"]+)"/)?.[1]
    expect(qrPath?.match(/M/g)).toHaveLength(541)
    expect(html).toContain('>@someone</span>')
    expect(html).not.toContain('𝕏')
    expect(html).not.toContain('lucide-qr-code')
    expect(html).toContain('aria-label="Middle center" aria-pressed="true"')
    expect(html).toContain('type="range" min="10" max="90" step="1" value="33"')
    expect(html).toContain('33% from top')
    expect(html.match(/type="number"/g)).toHaveLength(2)
    expect(html).toContain('0.0s → 8.0s')
    expect(html).toContain('2 watermarks · 50% opacity')
    expect(html).toContain('Set from playhead')
    expect(html).not.toContain('watermark-backdrop')
    expect(html).not.toContain('role="dialog"')
  })

  it('previews and configures a handle-only watermark', () => {
    const html = renderWatermark({
      includeQr: false,
      position: 'top-left',
      handleVerticalPercent: 68,
      endSeconds: null,
    })
    expect(html).toContain('watermark-preview-overlay watermark-preview-handle')
    expect(html).toContain('Handle only · 50% opacity')
    expect(html).not.toContain('watermark-preview-qr-modules')
    expect(html).not.toContain('watermark-preview-overlay watermark-preview-qr')
    expect(html).not.toContain('QR link')
    expect(html).toContain('aria-label="Top left" aria-pressed="true"')
    expect(html).toContain('top:68%;left:50%;transform:translate(-50%, -50%)')
    expect(html).toContain('68% from top')
  })
})

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
      includeXIcon: true,
      includeHandleBorder: true,
      handlePadding: 48,
      handleRounding: 60,
      qrOpacity: 0.35,
      handleOpacity: 0.7,
      qrStartSeconds: 0,
      qrEndSeconds: 4,
      handleStartSeconds: 0,
      handleEndSeconds: 8,
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
    expect(html).toContain('watermark-preview-handle-pill')
    expect(html).toContain('top:33%;left:50%;transform:translate(-50%, -50%)')
    const qrPath = html.match(/class="watermark-preview-qr-modules"[^>]*>\s*<path d="([^"]+)"/)?.[1]
    expect(qrPath?.match(/M/g)).toHaveLength(541)
    expect(html).toContain('>someone</span>')
    expect(html).not.toContain('>@someone</span>')
    expect(html).toContain('watermark-preview-x-icon')
    expect(html).not.toContain('lucide-qr-code')
    expect(html).toContain('aria-label="Middle center" aria-pressed="true"')
    expect(html).toContain('type="range" min="10" max="90" step="1" value="33"')
    expect(html).toContain('id="watermark-handle-padding" type="range" min="0" max="96" step="1" value="48"')
    expect(html).toContain('id="watermark-handle-rounding" type="range" min="0" max="100" step="1" value="60"')
    expect(html).toContain('33% from top')
    expect(html).toContain('Padding 48px · rounding 60%')
    expect(html.match(/type="number"/g)).toHaveLength(4)
    expect(html).toContain('QR 35% · 0.0s–4.0s')
    expect(html).toContain('Handle 70% · 0.0s–8.0s')
    expect(html).toContain('aria-label="QR start"')
    expect(html).toContain('aria-label="Handle end"')
    expect(html).toContain('Set from playhead')
    expect(html).not.toContain('watermark-backdrop')
    expect(html).not.toContain('role="dialog"')
  })

  it('previews and configures a handle-only watermark', () => {
    const html = renderWatermark({
      includeQr: false,
      position: 'top-left',
      handleVerticalPercent: 68,
      includeXIcon: false,
      includeHandleBorder: false,
      handlePadding: 0,
      handleRounding: 0,
      handleOpacity: 0.6,
      handleStartSeconds: 1,
      handleEndSeconds: null,
    })
    expect(html).toContain('watermark-preview-overlay watermark-preview-handle')
    expect(html).not.toContain('watermark-preview-qr-modules')
    expect(html).not.toContain('watermark-preview-overlay watermark-preview-qr')
    expect(html).not.toContain('QR link')
    expect(html).toContain('aria-label="Top left" aria-pressed="true"')
    expect(html).toContain('top:68%;left:50%;transform:translate(-50%, -50%)')
    expect(html).toContain('68% from top')
    expect(html).toContain('watermark-preview-handle-pill without-border')
    expect(html).toContain('padding-inline:0%;border-radius:0% / 0%')
    expect(html).not.toContain('watermark-preview-x-icon')
    expect(html).toContain('Handle 60% · 1.0s–12.0s')
    expect(html.match(/type="number"/g)).toHaveLength(2)
  })
})

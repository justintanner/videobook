import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfirmSheet } from '../../src/components/videobook/confirm/ConfirmSheet'
import {
  WatermarkBody,
  type WatermarkReviewState,
} from '../../src/components/videobook/confirm/bodies/WatermarkBody'
import { watermarkValidation } from '../../src/videobook/confirm-validation'

function renderWatermark(overrides: Partial<WatermarkReviewState> & { handle?: string } = {}): string {
  const state: WatermarkReviewState = {
    assetId: 'vid-1',
    targetLabel: '@a1',
    mediaUrl: '/files/book/vid-1/proxy.mp4',
    thumbnailUrl: '/files/book/vid-1/original.jpg',
    width: 1920,
    height: 1080,
    durationSeconds: 12,
    platform: 'x',
    identities: {
      x: { handle: overrides.handle ?? 'someone', recent: ['someone'] },
      tiktok: { handle: 'creator.name', recent: ['creator.name'] },
    },
    url: 'https://example.com/profile',
    includeQr: true,
    includeHandle: true,
    position: 'middle-center',
    handleVerticalPercent: 33,
    handlePlacement: 'center',
    includePlatformIcon: true,
    includeHandleBorder: true,
    handlePadding: 48,
    handlePaddingY: 24,
    handleRounding: 60,
    qrOpacity: 0.35,
    handleOpacity: 0.7,
    qrStartSeconds: 0,
    qrEndSeconds: 4,
    handleStartSeconds: 0,
    handleEndSeconds: 8,
    fadeSeconds: 0.5,
    saveDefault: false,
    loadingConfig: false,
    error: null,
    ...overrides,
  }
  // Rendered inside the shared confirm sheet, exactly as App does: the Apply
  // button and the status line come from the shell, the validation from the
  // pure validator.
  return renderToStaticMarkup(createElement(ConfirmSheet, {
    address: state.targetLabel,
    applyFormId: 'command-composer-form',
    ariaLabel: 'Watermark review',
    busy: false,
    children: createElement(WatermarkBody, {
      busy: false,
      state,
      onChange: () => undefined,
      onMediaMetadata: () => undefined,
    }),
    effect: { label: 'Rebuilds playable proxy', tone: 'default' },
    kind: 'watermark',
    tag: 'WATERMARK · CHAT',
    title: 'Add handle and QR to the video',
    validation: watermarkValidation({ ...state, handle: state.identities[state.platform].handle }),
    onCancel: () => undefined,
  }))
}

describe('watermark chat review', () => {
  it('renders one composer review with live placement and timing controls', () => {
    const html = renderWatermark()
    expect(html).toContain('confirm-sheet confirm-sheet-watermark')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('WATERMARK · CHAT')
    expect(html).toContain('Rebuilds playable proxy')
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
    expect(html).toContain('id="watermark-handle-padding-x" type="range" min="0" max="96" step="1" value="48"')
    expect(html).toContain('id="watermark-handle-padding-y" type="range" min="0" max="96" step="1" value="24"')
    expect(html).toContain('id="watermark-handle-rounding" type="range" min="0" max="100" step="1" value="60"')
    expect(html).toContain('33% from top')
    expect(html).toContain('aria-label="Handle placement"')
    expect(html).toContain('>Above QR</button>')
    expect(html).toContain('>On QR</button>')
    expect(html).toContain('>Below QR</button>')
    expect(html).toContain('<output for="watermark-qr-opacity">35%</output>')
    expect(html).toContain('<output for="watermark-handle-opacity">70%</output>')
    expect(html).toContain('id="watermark-fade" type="range" min="0" max="20" step="1" value="5"')
    expect(html).toContain('<output for="watermark-fade">0.5s</output>')
    // QR runs 0–4s of 12s: no fade in at the clip start, so the playhead at
    // 0s previews the full set opacity.
    expect(html).toContain('opacity:0.35')
    expect(html.match(/type="number"/g)).toHaveLength(6)
    expect(html).toContain('aria-label="QR start"')
    expect(html).toContain('aria-label="QR end"')
    expect(html).toContain('aria-label="Handle end"')
    expect(html).toContain('aria-label="QR duration"')
    expect(html).toContain('aria-label="Handle duration"')
    expect(html).toContain('>Include handle</strong>')
    expect(html).toContain('aria-label="Set QR start from playhead"')
    expect(html).toContain('aria-label="Use whole clip for Handle"')
    // A ready sheet has nothing to report, so it draws no footer: the effect
    // chip and the shortcut hints sit in the header beside the buttons they
    // drive, and the description still points at whichever element has them.
    expect(html).not.toContain('confirm-sheet-foot')
    expect(html).toContain('aria-describedby="_R_0_-status"')
    expect(html).toContain('<span id="_R_0_-status" class="confirm-sheet-head-hints">')
    expect(html).toContain('<div class="confirm-sheet-decisions"><span class="confirm-sheet-effect confirm-sheet-effect-default">Rebuilds playable proxy</span>')
    expect(html).toContain('class="confirm-sheet-apply">Apply <kbd>↵</kbd>')
  })

  it('previews a TikTok alias with its own icon and profile link', () => {
    const html = renderWatermark({ platform: 'tiktok', url: '' })
    expect(html).toContain('TikTok handle')
    expect(html).toContain('Show TikTok icon')
    expect(html).toContain('watermark-preview-tiktok-icon')
    expect(html).not.toContain('watermark-preview-x-icon')
    expect(html).toContain('https://www.tiktok.com/@creator.name')
    expect(html).toContain('>creator.name</span>')
    expect(html).toContain('value="tiktok" selected=""')
    const duration = html.match(/<input[^>]+aria-label="Handle duration"[^>]*>/)?.[0]
    expect(duration).toContain('value="8"')
    expect(html.indexOf('aria-label="Handle duration"')).toBeLessThan(html.indexOf('<video'))
  })

  it('gives the footer back the moment the sheet cannot apply', () => {
    const html = renderWatermark({ includeQr: false, includeHandle: false })
    expect(html).toContain('confirm-sheet-foot confirm-sheet-foot-blocking')
    expect(html).toContain('<strong>Can’t apply — </strong>')
    expect(html).not.toContain('confirm-sheet-head-hints')
    expect(html).not.toContain('confirm-sheet-head-divider')
    expect(html.indexOf('Rebuilds playable proxy')).toBeLessThan(html.indexOf('</header>'))
    expect(html).not.toContain('confirm-sheet-aside')
    expect(html).toContain('disabled=""')
  })

  it('previews and configures a handle-only watermark', () => {
    const html = renderWatermark({
      includeQr: false,
      position: 'top-left',
      handleVerticalPercent: 68,
      handlePlacement: 'center',
      includePlatformIcon: false,
      includeHandleBorder: false,
      handlePadding: 0,
      handlePaddingY: 0,
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
    expect(html).toContain('padding-inline:0em;border-radius:0em')
    expect(html).toContain('>Above QR</button>')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('watermark-preview-x-icon')
    expect(html).toContain('<output for="watermark-handle-opacity">60%</output>')
    expect(html.match(/type="number"/g)).toHaveLength(3)
    const duration = html.match(/<input[^>]+aria-label="Handle duration"[^>]*>/)?.[0]
    expect(duration).toContain('value="11"')
  })

  it('previews the handle sitting on the QR', () => {
    const html = renderWatermark({
      position: 'bottom-right',
      handlePlacement: 'on-qr',
      handlePadding: 32,
      handlePaddingY: 32,
    })
    expect(html).toContain('aria-pressed="true">On QR</button>')
    expect(html).not.toContain('id="watermark-handle-vertical"')
    expect(html).toContain('The handle sits with the QR.')
    expect(html).toContain('width:9%;height:auto;top:')
    expect(html).toContain('left:89%')
    expect(html).not.toContain('top:33%;left:50%;transform:translate(-50%, -50%)')
  })

  it('allows a QR-only watermark with invalid handle timing', () => {
    const html = renderWatermark({
      handle: '',
      url: 'https://example.com/qr-only',
      includeHandle: false,
      handleStartSeconds: 0,
      handleEndSeconds: 0,
      fadeSeconds: 0,
    })
    expect(html).toContain('<output for="watermark-fade">Off</output>')
    const applyButton = html.match(/<button type="submit"[^>]*>/)?.[0]
    expect(applyButton).not.toContain('disabled')
    expect(html).toContain('watermark-preview-overlay watermark-preview-qr')
    expect(html).not.toContain('watermark-preview-overlay watermark-preview-handle')
    expect(html).not.toContain('aria-label="Handle end"')
    expect(html).not.toContain('Handle end time must be after its start time.')
    expect(html).not.toContain('id="watermark-handle-opacity"')
    expect(html.match(/type="number"/g)).toHaveLength(3)
  })

  it('explains a missing handle in the footer and marks the field', () => {
    const html = renderWatermark({ handle: '' })
    expect(html).toContain('confirm-sheet-foot confirm-sheet-foot-blocking')
    expect(html).toContain('Can’t apply')
    expect(html).toContain('no handle is set')
    expect(html).toContain('class="confirm-sheet-apply" disabled=""')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('Required while Include handle is on')
  })
})

import { describe, expect, it } from 'vitest'
import {
  COMPOSER_DOCK_HEADER_PX,
  COMPOSER_DOCK_MAX_DVH,
  COMPOSER_DOCK_MAX_PX,
  composerDockCloseInPanel,
  composerDockHeightPx,
  composerDockNoticeInHeader,
  composerDockReviewPriority,
  composerHistoryChromeHosted,
  composerMediaRowHeightPx,
  musicDockViewAfterSetup,
  type ComposerDockCloseOwner,
} from './composer-dock'

function owner(patch: Partial<ComposerDockCloseOwner> = {}): ComposerDockCloseOwner {
  return { dockOpen: true, panelHasHeader: true, reviewPriority: false, ...patch }
}

describe('composer dock close ownership', () => {
  it('hands the control to a panel that draws its own header row', () => {
    expect(composerDockCloseInPanel(owner())).toBe(true)
  })

  it('keeps the strip when no panel offers a header row', () => {
    expect(composerDockCloseInPanel(owner({ panelHasHeader: false }))).toBe(false)
  })

  it('keeps the strip while a pending review covers the panel', () => {
    const reviewPriority = composerDockReviewPriority(true)
    expect(composerDockCloseInPanel(owner({ reviewPriority }))).toBe(false)
  })

  it('does not give a collapsed contextual panel the close control', () => {
    expect(composerDockCloseInPanel(owner({ dockOpen: false }))).toBe(false)
    expect(composerDockCloseInPanel(owner({ dockOpen: false, panelHasHeader: false })))
      .toBe(false)
  })

  it('hosts history chrome in the same panel header that took the close', () => {
    expect(composerHistoryChromeHosted(owner())).toBe(true)
    expect(composerHistoryChromeHosted(owner({ panelHasHeader: false }))).toBe(false)
    expect(composerHistoryChromeHosted(owner({ dockOpen: false }))).toBe(false)
  })
})

describe('music dock view after soundtrack apply', () => {
  it('leaves soundtrack for the sources list once the master is applied', () => {
    expect(musicDockViewAfterSetup('applied', 'soundtrack')).toBe('sources')
    expect(musicDockViewAfterSetup('applied', 'clip')).toBe('clip')
    expect(musicDockViewAfterSetup('ready', 'soundtrack')).toBe('soundtrack')
  })
})

describe('composer dock height at 900px-tall viewports', () => {
  it('keeps the dock inside 56dvh and spends the header merge on the media row', () => {
    expect(COMPOSER_DOCK_HEADER_PX).toBe(40)
    expect(COMPOSER_DOCK_MAX_PX).toBe(560)
    expect(COMPOSER_DOCK_MAX_DVH).toBe(56)
    expect(composerDockHeightPx(900)).toBe(504)
    expect(composerDockHeightPx(900)).toBeLessThanOrEqual(0.56 * 900)
    expect(composerDockHeightPx(1200)).toBe(560)
    expect(composerMediaRowHeightPx(900)).toBe(440)
    expect(composerMediaRowHeightPx(900)).toBeGreaterThan(426)
  })
})

describe('where the composer status line reads', () => {
  it('rides the dock header the composer draws for its own close', () => {
    const closeInPanel = composerDockCloseInPanel(owner({ panelHasHeader: false }))
    expect(composerDockNoticeInHeader({ dockOpen: true, closeInPanel })).toBe(true)
  })

  it('stays in the body when a panel took the close and drew no header for it', () => {
    const closeInPanel = composerDockCloseInPanel(owner())
    expect(composerDockNoticeInHeader({ dockOpen: true, closeInPanel })).toBe(false)
  })

  it('stays in the body while the dock is closed, where the body hides it', () => {
    const closeInPanel = composerDockCloseInPanel(owner({ dockOpen: false }))
    expect(composerDockNoticeInHeader({ dockOpen: false, closeInPanel })).toBe(false)
  })
})

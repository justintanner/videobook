import { describe, expect, it } from 'vitest'
import {
  composerDockCloseInPanel,
  composerDockNoticeInHeader,
  composerDockReviewPriority,
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

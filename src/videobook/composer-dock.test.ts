import { describe, expect, it } from 'vitest'
import {
  composerDockCloseInPanel,
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

  it('keeps the strip while the dock is closed so it can be reopened', () => {
    expect(composerDockCloseInPanel(owner({ dockOpen: false }))).toBe(false)
    expect(composerDockCloseInPanel(owner({ dockOpen: false, panelHasHeader: false })))
      .toBe(false)
  })
})

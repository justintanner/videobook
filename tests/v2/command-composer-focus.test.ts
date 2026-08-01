import { describe, expect, it, vi } from 'vitest'
import { restoreCommandComposerFocus } from '../../src/videobook/command-composer-focus'

describe('command composer focus restoration', () => {
  it('waits for dismissal layout before focusing without scrolling', () => {
    const frames: FrameRequestCallback[] = []
    const focus = vi.fn()

    restoreCommandComposerFocus(
      () => ({ focus }),
      (callback) => {
        frames.push(callback)
        return frames.length
      },
    )

    expect(focus).not.toHaveBeenCalled()
    frames.shift()?.(0)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does nothing when the composer is no longer mounted', () => {
    const frames: FrameRequestCallback[] = []

    restoreCommandComposerFocus(
      () => null,
      (callback) => {
        frames.push(callback)
        return frames.length
      },
    )

    expect(() => frames.shift()?.(0)).not.toThrow()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { revealNotebookResult } from '../../src/videobook/notebook-result-reveal'

describe('notebook result reveal', () => {
  it('waits for refreshed layout before smoothly scrolling to the latest end', () => {
    const frames: FrameRequestCallback[] = []
    const scheduleFrame = (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }
    const scrollTo = vi.fn()
    const target = { scrollHeight: 1200, scrollTo }

    revealNotebookResult(() => target, scheduleFrame)

    expect(scrollTo).not.toHaveBeenCalled()
    frames.shift()?.(0)
    expect(scrollTo).not.toHaveBeenCalled()
    target.scrollHeight = 1480
    frames.shift()?.(16)

    expect(scrollTo).toHaveBeenCalledOnce()
    expect(scrollTo).toHaveBeenCalledWith({
      top: 1480,
      behavior: 'smooth',
    })
  })

  it('does nothing when the notebook canvas is no longer mounted', () => {
    const frames: FrameRequestCallback[] = []
    const scheduleFrame = (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }

    revealNotebookResult(() => null, scheduleFrame)
    frames.shift()?.(0)
    frames.shift()?.(16)

    expect(frames).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { extractStreamingVisuals } from './streamingVisuals'

describe('extractStreamingVisuals', () => {
  it('returns nothing for an empty buffer', () => {
    expect(extractStreamingVisuals('')).toEqual({ complete: [], partial: null })
  })

  it('treats an open visual as the partial scene', () => {
    const raw = '{"visuals":[{"visual":"a man stands in the'
    expect(extractStreamingVisuals(raw)).toEqual({
      complete: [],
      partial: 'a man stands in the',
    })
  })

  it('promotes a closed visual to complete and tracks the next partial', () => {
    const raw = '{"visuals":[{"visual":"first scene"},{"visual":"second scene in pro'
    expect(extractStreamingVisuals(raw)).toEqual({
      complete: ['first scene'],
      partial: 'second scene in pro',
    })
  })

  it('returns all complete visuals with no partial when the JSON is finished', () => {
    const raw = '{"visuals":[{"visual":"first"},{"visual":"second"}]}'
    expect(extractStreamingVisuals(raw)).toEqual({
      complete: ['first', 'second'],
      partial: null,
    })
  })

  it('unescapes JSON escape sequences in scene text', () => {
    const raw = '{"visuals":[{"visual":"a \\"quoted\\" line\\nnext row"}]}'
    expect(extractStreamingVisuals(raw)).toEqual({
      complete: ['a "quoted" line\nnext row'],
      partial: null,
    })
  })

  it('tolerates a partial ending mid-escape', () => {
    const raw = '{"visuals":[{"visual":"trailing backslash \\'
    const { complete, partial } = extractStreamingVisuals(raw)
    expect(complete).toEqual([])
    expect(partial).toBe('trailing backslash ')
  })
})

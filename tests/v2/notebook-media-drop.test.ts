import { describe, expect, it } from 'vitest'
import { mediaKindForFile } from '../../src/videobook/notebook-media-drop'

describe('notebook media drop', () => {
  it('recognizes image, video, and audio MIME types', () => {
    expect(mediaKindForFile({ name: 'still.bin', type: 'image/png' })).toBe('image')
    expect(mediaKindForFile({ name: 'clip.bin', type: 'video/mp4' })).toBe('video')
    expect(mediaKindForFile({ name: 'voice.bin', type: 'audio/wav' })).toBe('audio')
  })

  it('falls back to supported filename extensions', () => {
    expect(mediaKindForFile({ name: 'STILL.WEBP', type: '' })).toBe('image')
    expect(mediaKindForFile({ name: 'clip.MOV', type: '' })).toBe('video')
    expect(mediaKindForFile({ name: 'voice.M4A', type: '' })).toBe('audio')
    expect(mediaKindForFile({ name: 'notes.md', type: 'text/markdown' })).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { rebaseCellFormDraft, sameCellFormDraft, type CellFormDraft } from '../../src/videobook/cell-form-draft'

const stored: CellFormDraft = {
  prompt: 'Blend @image1 into @image2',
  provider: 'kie',
  model: 'kie:grok-imagine-video-1-5-preview',
  operation: 'image_to_video',
  tool: 'generate_video',
  startSeconds: '0',
  endSeconds: '0',
  overlap: '0',
  frameMode: 'first',
  timestampSeconds: '0',
  generationMode: 'i2v',
  generationSettings: { duration: 10 },
}

const picked: CellFormDraft = {
  ...stored,
  model: 'kie:grok-imagine/image-to-video',
  generationMode: 'default',
  generationSettings: { resolution: '720p' },
}

describe('rebaseCellFormDraft', () => {
  it('keeps a model picked in the form when only the stored prompt changes', () => {
    const remapped = { ...stored, prompt: 'Blend @image2 into @image1' }
    expect(rebaseCellFormDraft(picked, { stored, draft: stored }, { stored: remapped, draft: remapped }))
      .toEqual({ ...picked, prompt: 'Blend @image2 into @image1' })
  })

  it('keeps typed text over a stored prompt change and follows the store where the form is untouched', () => {
    const typed = { ...stored, prompt: 'Blend slowly' }
    const changed = { ...stored, prompt: 'Seeded @image1', model: 'kie:wan/3-0-video', generationSettings: { duration: 5 } }
    expect(rebaseCellFormDraft(typed, { stored, draft: stored }, { stored: changed, draft: changed }))
      .toEqual({ ...changed, prompt: 'Blend slowly' })
  })

  it('takes the opened value of a changed field, not the raw stored one', () => {
    const opened = { ...stored, generationMode: 'r2v', prompt: 'Blend @image1 into @image2 again' }
    const raw = { ...stored, generationMode: '', prompt: 'Blend @image1 into @image2 again' }
    expect(rebaseCellFormDraft(stored, { stored, draft: stored }, { stored: raw, draft: opened }))
      .toEqual(opened)
  })

  it('leaves the form alone when the store matches what it last saw', () => {
    expect(rebaseCellFormDraft(picked, { stored, draft: stored }, { stored, draft: picked })).toEqual(picked)
  })
})

describe('sameCellFormDraft', () => {
  it('compares settings by value', () => {
    expect(sameCellFormDraft(stored, { ...stored, generationSettings: { duration: 10 } })).toBe(true)
    expect(sameCellFormDraft(stored, { ...stored, generationSettings: { duration: 8 } })).toBe(false)
  })
})

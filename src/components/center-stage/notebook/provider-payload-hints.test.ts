import { describe, expect, it } from 'vitest'
import { inspectProviderPayloadSlugs } from './provider-payload-hints'

describe('inspectProviderPayloadSlugs', () => {
  it('flags local slugs remaining in the prompt (vc-gb9g repro)', () => {
    const hints = inspectProviderPayloadSlugs({
      model: 'bytedance/seedance-2-mini',
      input: {
        prompt: 'scene @vid-full-notats replace attress with @img-actress',
        reference_image_urls: ['@img-actress'],
        reference_video_urls: ['@vid-full-notats'],
      },
    })
    expect(hints.promptSlugs).toEqual(['@vid-full-notats', '@img-actress'])
    expect(hints.urlSlugs).toEqual(['@img-actress', '@vid-full-notats'])
  })

  it('treats rewritten Seedance markers as clean wire-form prompt', () => {
    const hints = inspectProviderPayloadSlugs({
      model: 'bytedance/seedance-2-mini',
      input: {
        prompt: 'scene @Video1 replace attress with @Image1',
        reference_image_urls: ['@img-actress'],
        reference_video_urls: ['@vid-full-notats'],
      },
    })
    expect(hints.promptSlugs).toEqual([])
    expect(hints.urlSlugs).toEqual(['@img-actress', '@vid-full-notats'])
  })

  it('does not treat provider markers as local asset slugs', () => {
    const hints = inspectProviderPayloadSlugs({
      input: {
        prompt: '@Image1 and @Video1 and @referenceImage_1',
        reference_image_urls: ['https://cdn.example/a.png'],
      },
    })
    expect(hints.promptSlugs).toEqual([])
    expect(hints.urlSlugs).toEqual([])
  })

  it('leaves non-asset @tokens in the prompt alone', () => {
    const hints = inspectProviderPayloadSlugs({
      input: { prompt: '@notify support about the edit' },
    })
    expect(hints.promptSlugs).toEqual([])
  })
})

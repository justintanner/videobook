import { describe, expect, it } from 'vitest'
import { providerPayloadPreviewMentions } from '../../src/videobook/provider-payload-preview'

describe('provider payload preview mentions', () => {
  it('reads server-classified prompt leaks and dispatch placeholders', () => {
    expect(providerPayloadPreviewMentions({
      mentions: {
        prompt_leaks: [{
          token: '@a2',
          code: 'not_connected',
          message: '@a2 is referenced but not connected',
        }],
        url_placeholders: [{
          path: 'input.video_urls[0]',
          reference: '@vid-source',
          url: 'http://url.resolved.later.for/vid-source',
        }],
      },
    })).toEqual({
      promptLeaks: [{
        token: '@a2',
        code: 'not_connected',
        message: '@a2 is referenced but not connected',
      }],
      urlPlaceholders: [{
        path: 'input.video_urls[0]',
        reference: '@vid-source',
        url: 'http://url.resolved.later.for/vid-source',
      }],
    })
  })

  it('ignores malformed client data without classifying payload text', () => {
    expect(providerPayloadPreviewMentions({
      payload: {
        prompt: 'unclassified @a2',
        image_url: 'http://url.resolved.later.for/img-source',
      },
      mentions: {
        prompt_leaks: [{ token: '@a2' }],
        url_placeholders: ['img-source'],
      },
    })).toEqual({ promptLeaks: [], urlPlaceholders: [] })
  })
})

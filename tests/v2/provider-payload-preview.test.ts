import { describe, expect, it } from 'vitest'
import {
  providerPayloadPreviewMentions,
  providerPayloadPreviewReferenceError,
} from '../../src/videobook/provider-payload-preview'

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

  it('returns a blocking generation error for server-classified prompt leaks', () => {
    expect(providerPayloadPreviewReferenceError({
      mentions: {
        prompt_leaks: [{
          token: '@e2',
          code: 'no_output',
          message: '@e2 does not have media output yet',
        }],
      },
    })).toBe(
      'Fix prompt references before generating: @e2 does not have media output yet',
    )
    expect(providerPayloadPreviewReferenceError({ mentions: {} })).toBeNull()
  })
})

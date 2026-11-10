import { describe, expect, it } from 'vitest'
import {
  generationEstimate,
  generationEstimateCaption,
  historicalAverageEstimate,
  lowerBoundCaption,
  lowerBoundEstimate,
  PER_CALL_AVERAGE_CAPTION,
  providerPayloadPreviewMentions,
  providerPayloadPreviewReferenceError,
  workspaceEstimateCost,
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

describe('generation cost preview', () => {
  const historical = "fal pricing estimate for 'fal-ai/flux-2-flex' is fal's historical average per call x 1; it ignores this request's payload"

  it('keeps a historical fal average as a known price', () => {
    expect(historicalAverageEstimate([historical])).toBe(true)
    expect(historicalAverageEstimate([historical, 'model not found'])).toBe(false)
    const estimate = generationEstimate({
      estimate: { usd: 0.17, currency: 'USD', warnings: [historical] },
    })
    expect(estimate).toEqual({
      usd: 0.17,
      currency: 'USD',
      warnings: [historical],
      unknown: false,
    })
    expect(generationEstimateCaption(estimate)).toBe(PER_CALL_AVERAGE_CAPTION)
    expect(PER_CALL_AVERAGE_CAPTION).toBe('Per-call average, not this request\'s price')
  })

  it('keeps an H3 Max per-second floor as a known lower bound and captions why fal can bill more', () => {
    const extend = "fal 'minimax/h3-max/extend-video': prices the requested seconds only; reference tokens beyond the included 4,096 ($0.02 per 1,000) are not counted, so this estimate is a lower bound"
    const lipSync = "fal 'minimax/h3-max/lip-sync/image-to-video': prices the hinted audio seconds only; fal may bill a longer whole-second length than the hint, so this estimate is a lower bound"
    expect(lowerBoundEstimate([extend])).toBe(true)
    expect(lowerBoundEstimate([extend, historical])).toBe(false)
    expect(lowerBoundEstimate([])).toBe(false)
    const estimate = generationEstimate({ estimate: { usd: 1.6, currency: 'USD', warnings: [extend] } })
    expect(estimate).toEqual({ usd: 1.6, currency: 'USD', warnings: [extend], unknown: false })
    expect(generationEstimateCaption(estimate)).toBe('Prices the requested seconds only; reference tokens beyond the included 4,096 ($0.02 per 1,000) are not counted')
    expect(lowerBoundCaption([lipSync])).toBe('Prices the hinted audio seconds only; fal may bill a longer whole-second length than the hint')
    expect(lowerBoundCaption(['this estimate is a lower bound because of tokens'])).toBe('This estimate is a lower bound because of tokens')
  })

  it('labels a workspace generation quote, at least the floor for a lower bound and unavailable for an unpriced warning', () => {
    const floor = "fal 'minimax/h3-max/extend-video': prices the requested seconds only; reference tokens beyond the included 4,096 ($0.02 per 1,000) are not counted, so this estimate is a lower bound"
    expect(workspaceEstimateCost(1.6, [floor])).toBe('Estimated cost: at least $1.6000')
    expect(workspaceEstimateCost(0.17, [historical])).toBe('Estimated cost: $0.1700')
    expect(workspaceEstimateCost(0.04, [])).toBe('Estimated cost: $0.0400')
    expect(workspaceEstimateCost(0, ["model 'x' not found in pricing table"])).toBe('Cost estimate unavailable')
    expect(workspaceEstimateCost(1.6, [floor, 'model not found'])).toBe('Cost estimate unavailable')
    expect(workspaceEstimateCost(null, [])).toBe('Cost estimate unavailable')
  })

  it('treats an unknown model warning as an unavailable price', () => {
    expect(generationEstimate({
      estimate: { usd: 0, warnings: ['model not found in pricing table'] },
    })).toMatchObject({ usd: 0, currency: 'USD', unknown: true })
  })
})

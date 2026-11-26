import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RoutedBody } from '../../src/components/videobook/confirm/bodies/RoutedBody'
import {
  chainStepReview,
  routedActionReview,
  type ChainStepReviewValue,
} from '../../src/videobook/chat-action-review'
import { asChatActionPlan, dubStartedMessage } from '../../src/videobook/workspace-responses'

function values(
  tool: string,
  params: Record<string, unknown>,
  input: string,
  sourceDurationSeconds?: number | null,
) {
  const review = routedActionReview({ tool, params, input, sourceDurationSeconds })
  return {
    title: review.title,
    settings: Object.fromEntries(
      review.settings.map((setting) => [setting.label, setting.value]),
    ),
  }
}

describe('routedActionReview', () => {
  it('shows source duration, speed, and expected duration for change_video_speed', () => {
    expect(values(
      'change_video_speed',
      { asset_id: 'vid-source', speed: 1.3 },
      'speed up @d2 to 1.3x',
      6,
    )).toEqual({
      title: 'Change video speed',
      settings: {
        Source: '@d2',
        'Source duration': '0:06',
        Speed: '1.3×',
        'Expected duration': '0:04.62',
        Output: 'Existing source updated in place',
        Recovery: 'Previous version retained',
      },
    })
    expect(routedActionReview({
      tool: 'change_video_speed',
      params: { asset_id: 'vid-source', speed: 1.3 },
      input: 'speed up @d2 to 1.3x',
      sourceDurationSeconds: 6,
    }).settings.find((setting) => setting.label === 'Output'))
      .toMatchObject({ tone: 'warning' })
  })

  it('derives the effective speed from target duration input', () => {
    expect(values(
      'change_video_speed',
      { asset_id: 'vid-source', target_duration_seconds: 4.6 },
      'make @d2 exactly 4.6s',
      6,
    )).toEqual({
      title: 'Change video speed',
      settings: {
        Source: '@d2',
        'Source duration': '0:06',
        Speed: '1.3× (from target duration)',
        'Target duration': '0:04.60',
        Output: 'Existing source updated in place',
        Recovery: 'Previous version retained',
      },
    })
  })

  it('degrades to calculated-on-apply when the source duration is unknown', () => {
    expect(values(
      'change_video_speed',
      { asset_id: 'vid-source' },
      'change the speed of @d2',
      null,
    ).settings).toEqual({
      Source: '@d2',
      Speed: 'Calculated on apply',
      Output: 'Existing source updated in place',
      Recovery: 'Previous version retained',
    })
    expect(values(
      'change_video_speed',
      { asset_id: 'vid-source', target_duration_seconds: 5 },
      'make @d2 exactly 5s',
      null,
    ).settings).toMatchObject({
      Speed: 'Calculated on apply',
      'Target duration': '0:05',
    })
  })

  it('hides sensitive values in the generic fallback', () => {    expect(values(
      'set_env_secret',
      { key: 'OPENAI_API_KEY', value: 'secret-value' },
      'set a provider secret',
    ).settings).toEqual({
      Key: 'OPENAI_API_KEY',
      Value: 'Hidden',
    })
  })

  it('keeps routed URLs complete and marks them for full-width display', () => {
    const url = 'https://x.com/BardiGangUpdate/status/1297030012345678901?source=videobook&include=complete'
    const review = routedActionReview({
      tool: 'download_video',
      params: { url, export_videos: false, full: false },
      input: `download ${url}`,
    })

    expect(review.settings[0]).toEqual({
      label: 'Url',
      value: url,
      tone: 'default',
      wide: true,
    })
  })

  it('prepares an exact post-to-X confirmation without truncating its message', () => {
    const postText = `${'Full outbound message '.repeat(6).trim()}\nSecond line stays visible.`
    const review = routedActionReview({
      tool: 'post',
      params: {
        asset_id: 'vid-source',
        orientation: 'portrait',
        to: 'x',
        scheduled_for: '2026-08-25T03:00:00.000Z',
        text: postText,
      },
      input: 'post @a1 to X tomorrow',
    })

    expect(review).toEqual({
      title: 'Post to X',
      settings: [
        { label: 'Destination', value: 'X', tone: 'default', wide: false },
        { label: 'Source', value: '@a1', tone: 'default', wide: false },
        {
          label: 'Publish',
          value: 'Scheduled · 2026-08-25T03:00:00.000Z',
          tone: 'default',
          wide: true,
        },
        { label: 'Orientation', value: 'Portrait', tone: 'default', wide: false },
      ],
      effect: { label: 'Publishes to X · scheduled', tone: 'default' },
      postText,
    })
  })

  it('summarizes a combined extract-then-replace chain', () => {
    expect(routedActionReview({
      tool: 'chain',
      params: {
        action: 'run',
        version: 1,
        steps: [
          { id: 'extract', tool: 'extract_audio', params: { asset_id: '@b2' } },
          {
            id: 'replace',
            tool: 'replace_video_audio',
            params: { asset_id: '@c4' },
          },
        ],
      },
      input: 'extract audio from @b2 and use it to replace the audio on the video in @c4',
    })).toMatchObject({
      title: 'Chained actions',
      settings: [
        { label: 'Step 1', value: 'Extract audio · @b2' },
        { label: 'Step 2', value: 'Replace video audio · @c4' },
      ],
      effect: { label: 'In place · previous version kept', tone: 'warning' },
    })
  })

  it('labels an immediate media-only X post', () => {
    expect(routedActionReview({
      tool: 'post',
      params: { asset_id: 'img-source', to: 'x' },
      input: 'post @b2 to X',
    })).toMatchObject({
      title: 'Post to X',
      postText: '',
      settings: [
        { label: 'Destination', value: 'X' },
        { label: 'Source', value: '@b2' },
        { label: 'Publish', value: 'Now' },
        { label: 'Orientation', value: 'Keep source' },
      ],
    })
  })
})

describe('chainStepReview', () => {
  function stepReview(patch: Partial<ChainStepReviewValue> = {}): ChainStepReviewValue {
    return {
      stepId: 'animate',
      index: 1,
      total: 3,
      tool: 'generate_kie_seedance_2_5_video',
      title: 'Generate seedance 2 5 video',
      address: '@b2',
      params: { prompt: 'Animate the frame', duration: '5', resolution: '720p' },
      estimateUsd: 0.38,
      estimateUnavailable: false,
      reason: 'Step 2 of 3',
      ...patch,
    }
  }

  it('names the step, its source, and what approving spends', () => {
    const review = chainStepReview(stepReview(), 1)
    expect(review.title).toBe('Step 2 of 3 · Generate seedance 2 5 video')
    expect(review.postText).toBe('Animate the frame')
    expect(review.effect).toEqual({
      label: 'Spends about $0.38',
      tone: 'warning',
    })
    const settings = Object.fromEntries(
      review.settings.map((setting) => [setting.label, setting.value]),
    )
    expect(settings.Step).toBe('2 of 3')
    expect(settings.Source).toBe('@b2')
    expect(settings['Estimated cost']).toBe('$0.38')
    expect(settings['Remaining steps']).toBe('1')
  })

  it('says a fal historical quote is a per-call average and not this request', () => {
    const review = chainStepReview(stepReview({
      estimateUsd: 0.32,
      estimateWarnings: ["fal pricing estimate for 'minimax/h3-max/extend-video' is fal's historical average per call x 1; it ignores this request's payload"],
    }), 0)
    expect(review.effect?.label).toBe('Per-call average $0.32, not this request\'s price')
    expect(review.settings.find((setting) => setting.label === 'Estimated cost')).toMatchObject({
      value: 'Per-call average $0.32',
      tone: 'warning',
    })
  })

  it('says an H3 Max per-second floor spends at least its figure', () => {
    const review = chainStepReview(stepReview({
      estimateUsd: 4.8,
      estimateWarnings: ["fal 'minimax/h3-max/extend-video': prices the requested seconds only; reference tokens beyond the included 4,096 ($0.02 per 1,000) are not counted, so this estimate is a lower bound"],
    }), 0)
    expect(review.effect?.label).toBe('Spends at least $4.80')
    expect(review.settings.find((setting) => setting.label === 'Estimated cost')).toMatchObject({
      value: 'At least $4.80',
      tone: 'warning',
    })
  })

  it('says a cost is unknown rather than showing it as free', () => {
    const review = chainStepReview(
      stepReview({ estimateUsd: null, estimateUnavailable: true }),
      0,
    )
    const cost = review.settings.find((setting) => setting.label === 'Estimated cost')
    expect(cost).toMatchObject({ value: 'Unknown', tone: 'warning' })
    expect(review.effect?.label).toBe('Cost unknown for this model')
    expect(
      review.settings.find((setting) => setting.label === 'Remaining steps')?.value,
    ).toBe('None')
  })
})

describe('dub review', () => {
  const lowerBound = "fal 'fal-ai/heygen/v2/translate/precision': prices the source video's 5s across 2 languages at $0.10/s; HeyGen bills whole seconds of output video, which can differ from the source (more so with dynamic_duration), so this estimate is a lower bound"

  function dubReview(params: Record<string, unknown>, estimate: { usd: number | null; warnings: string[] } | null) {
    return routedActionReview({
      tool: 'dub_video',
      params: { asset_id: '019fcc00-0000-7000-8000-0000000000a1', notebook_id: '019fcc00-0000-7000-8000-0000000000aa', ...params },
      input: 'make a Thai and Japanese version of @a1 with the best lip sync',
      estimate,
    })
  }

  it('shows the resolved languages, tier, lip sync and the lower-bound price', () => {
    const review = dubReview(
      { language: ['Thai (Thailand)', 'Japanese'], quality: 'precision' },
      { usd: 1, warnings: [lowerBound] },
    )
    expect(review.title).toBe('Dub into 2 languages')
    expect(Object.fromEntries(review.settings.map((entry) => [entry.label, entry.value]))).toEqual({
      Source: '@a1',
      Languages: 'Thai (Thailand), Japanese',
      Quality: 'Precision · better lip sync',
      'Lip sync': 'On · lips follow the new speech',
      'Estimated cost': 'At least $1.00',
      Output: '2 new videos · source unchanged',
      Pricing: "Prices the source video's 5s across 2 languages at $0.10/s; HeyGen bills whole seconds of output video, which can differ from the source (more so with dynamic_duration)",
    })
    expect(review.effect).toEqual({ label: 'Spends at least $1.00 · source unchanged', tone: 'warning' })
    expect(review.settings.some((entry) => entry.value.includes('019fcc00-0000-7000-8000-0000000000aa'))).toBe(false)

    const html = renderToStaticMarkup(createElement(RoutedBody, { prompt: 'make a Thai and Japanese version of @a1', settings: review.settings }))
    for (const text of ['Thai (Thailand), Japanese', 'Precision · better lip sync', 'On · lips follow the new speech', 'At least $1.00']) {
      expect(html).toContain(text)
    }
  })

  it('names a single voice-only speed dub and an unknown price plainly', () => {
    const review = dubReview({ language: ['Spanish'], lip_sync: false }, null)
    expect(review.title).toBe('Dub into Spanish')
    expect(Object.fromEntries(review.settings.map((entry) => [entry.label, entry.value]))).toMatchObject({
      Language: 'Spanish',
      Quality: 'Speed',
      'Lip sync': 'Off · voice only',
      'Estimated cost': 'Unknown',
      Output: '1 new video · source unchanged',
    })
    expect(review.effect?.label).toBe('Spends provider money · source unchanged')
    expect(review.settings.some((entry) => entry.label === 'Note')).toBe(false)

    const tooLong = dubReview({ language: ['Spanish'] }, {
      usd: null,
      warnings: ["Source video is 481s long, which exceeds HeyGen Translate's 480s (8-minute) limit. Use trim_video to shorten it first."],
    })
    expect(tooLong.settings.find((entry) => entry.label === 'Note')).toEqual({
      label: 'Note',
      value: "Source video is 481s long, which exceeds HeyGen Translate's 480s (8-minute) limit. Use trim_video to shorten it first.",
      tone: 'warning',
      wide: true,
    })
  })

  it('keeps the plan price through parsing and words the started dubs', () => {
    const plan = asChatActionPlan({
      kind: 'chat-action-plan',
      planId: '019fcc00-0000-7000-8000-000000000001',
      bookId: '019fcc00-0000-7000-8000-000000000002',
      prompt: 'dub @a1 into Thai',
      routedTool: 'dub_video',
      tool: 'dub_video',
      params: { asset_id: 'video-1', language: ['Thai (Thailand)'] },
      message: 'Dubbing into Thai (Thailand).',
      summary: 'Dubbing into Thai (Thailand).',
      effect: 'mutation',
      confirmation: { required: true, reason: 'Dubbing spends provider money' },
      estimate: { usd: 0.25, warnings: [lowerBound, 7] },
    })
    expect(plan.estimate).toEqual({ usd: 0.25, warnings: [lowerBound] })
    expect(dubStartedMessage({
      dubs: [{ language: 'Thai (Thailand)', asset_id: 'a' }, { language: 'Japanese', asset_id: 'b' }],
      status: 'enqueued',
    })).toBe('Dubbing into Thai (Thailand), Japanese')
    expect(dubStartedMessage({ status: 'enqueued' })).toBeNull()
  })
})

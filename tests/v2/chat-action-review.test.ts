import { describe, expect, it } from 'vitest'
import { routedActionReview } from '../../src/videobook/chat-action-review'

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
  it('shows the complete source-preserving extraction range', () => {
    expect(values(
      'extract_video_clip',
      { asset_id: 'vid-source', start_time: 15, end_time: 44 },
      'cut a new clip from @a1 from 15s to 44s',
    )).toEqual({
      title: 'Extract new video clip',
      settings: {
        Source: '@a1',
        Start: '0:15',
        End: '0:44',
        Duration: '0:29',
        Output: 'New clip · source preserved',
        Name: 'Automatic',
      },
    })
  })

  it('shows split defaults and the remaining clip', () => {
    expect(values(
      'split_video',
      { asset_id: 'vid-source', chunk_a_end: 15 },
      'trim @a1 15s and remaining',
    )).toEqual({
      title: 'Split video into two clips',
      settings: {
        Source: '@a1',
        'First clip': '0:00 → 0:15',
        'Remaining clip': '0:15 → end',
        Overlap: 'None',
        Output: 'Two new clips · source preserved',
      },
    })
  })

  it('distinguishes keep and remove trim modes', () => {
    const keepInput = {
      tool: 'trim_video',
      params: { asset_id: 'vid-source', trim_start: 4, trim_end: 12 },
      input: 'trim @a1 from 4s to 12s',
    }
    expect(values(
      'trim_video',
      keepInput.params,
      keepInput.input,
    )).toMatchObject({
      title: 'Trim video in place',
      settings: {
        Source: '@a1',
        Operation: 'Keep range',
        Start: '0:04',
        End: '0:12',
        Output: 'Existing source updated in place',
      },
    })
    expect(values(
      'trim_video',
      { asset_id: 'vid-source', cut_start: 4, cut_end: 12 },
      'remove 4s to 12s from @a1',
    )).toMatchObject({
      title: 'Remove section from video',
      settings: {
        Operation: 'Remove range',
      },
    })
    expect(routedActionReview(keepInput).settings.find(
      (setting) => setting.label === 'Output',
    )).toMatchObject({ tone: 'warning' })
  })

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
        platform: 'x',
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
      postText,
    })
  })

  it('labels an immediate media-only X post', () => {
    expect(routedActionReview({
      tool: 'post',
      params: { asset_id: 'img-source', platform: 'x' },
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

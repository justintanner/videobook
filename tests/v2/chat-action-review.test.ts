import { describe, expect, it } from 'vitest'
import { routedActionReview } from '../../src/videobook/chat-action-review'

function values(tool: string, params: Record<string, unknown>, input: string) {
  const review = routedActionReview({ tool, params, input })
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

  it('hides sensitive values in the generic fallback', () => {
    expect(values(
      'set_env_secret',
      { key: 'OPENAI_API_KEY', value: 'secret-value' },
      'set a provider secret',
    ).settings).toEqual({
      Key: 'OPENAI_API_KEY',
      Value: 'Hidden',
    })
  })
})

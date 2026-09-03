import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PostToXBody } from '../../src/components/videobook/confirm/bodies/PostToXBody'
import {
  defaultXPostScheduledFor,
  reviseXPostParams,
  reviseXPostFollowups,
  xPostDraftError,
  xPostDraftFromParams,
  xPostIsoDateTimeValue,
  xPostLocalDateTimeValue,
} from '../../src/videobook/x-post-review'
import { initialXPostThreadReview } from '../../src/videobook/x-post-thread'
import { initialXConnectionState } from '../../src/videobook/x-connection'

const ignoreChange = () => undefined

describe('PostToXBody', () => {
  it('renders an image and the complete outbound message', () => {
    const postText = 'First line stays exact.\nSecond line is not truncated.'
    const html = renderToStaticMarkup(createElement(PostToXBody, {
      asset: {
        type: 'image',
        mediaUrl: '/files/image-original.png',
        thumbnailUrl: '/files/image-thumbnail.jpg',
      },
      busy: false,
      draft: {
        postText,
        scheduledFor: '2099-08-25T03:00:00.000Z',
        orientation: null,
        followups: [],
      },
      onChange: ignoreChange,
      prompt: 'post @b2 to X tomorrow',
      settings: [],
      sourceLabel: '@b2',
    }))

    expect(html).toContain('aria-label="X post preview"')
    expect(html).toContain('src="/files/image-original.png"')
    expect(html).toContain('alt="@b2 post preview"')
    expect(html).toContain(postText)
    expect(html).toContain(`${postText.length}/280 characters`)
    expect(html).toContain('aria-label="Post options"')
    expect(html).toContain('aria-label="Publish timing"')
    expect(html).toContain('aria-label="Schedule date and time"')
    expect(html).toContain('aria-label="Video orientation" disabled=""')
    expect(html).not.toContain('<video')
  })

  it('renders video controls and a media-only message state', () => {
    const html = renderToStaticMarkup(createElement(PostToXBody, {
      asset: {
        type: 'video',
        mediaUrl: '/files/video-original.mp4',
        thumbnailUrl: '/files/video-poster.jpg',
      },
      busy: false,
      draft: {
        postText: '',
        scheduledFor: null,
        orientation: 'landscape',
        followups: [],
      },
      onChange: ignoreChange,
      prompt: 'post @a1 to X',
      settings: [],
      sourceLabel: '@a1',
    }))

    expect(html).toContain('<video')
    expect(html).toContain('src="/files/video-original.mp4"')
    expect(html).toContain('poster="/files/video-poster.jpg"')
    expect(html).toContain('controls=""')
    expect(html).toContain('placeholder="No message — media only"')
    expect(html).toContain('0/280 characters')
    expect(html).not.toContain('aria-label="Schedule date and time"')
  })

  it('renders the opt-in model, prompt and input images for videos', () => {
    const baseReview = initialXPostThreadReview({
      steps: [{
        id: 'generation',
        prompt: 'Exact final generation prompt',
        model: { label: 'Seedance 2.5', provider: 'Kie' },
        images: [{
          assetId: 'image-source',
          label: '@b2',
          mediaUrl: '/files/source.png',
          thumbnailUrl: '/files/source-thumb.jpg',
        }],
      }],
      credits: [{
        id: 'source',
        label: 'Source',
        url: 'https://x.com/source/status/123',
        xHandle: 'source',
      }],
    })
    const html = renderToStaticMarkup(createElement(PostToXBody, {
      asset: {
        type: 'video',
        mediaUrl: '/files/video.mp4',
        thumbnailUrl: null,
      },
      busy: false,
      draft: {
        postText: 'Root post',
        scheduledFor: null,
        orientation: null,
        followups: [],
      },
      onChange: ignoreChange,
      onThreadCreditsChange: ignoreChange,
      onThreadOptionsChange: ignoreChange,
      onThreadPromptChange: ignoreChange,
      prompt: 'post @a1 to X',
      settings: [],
      sourceLabel: '@a1',
      threadReview: {
        ...baseReview,
        options: { ...baseReview.options, enabled: true },
      },
    }))

    expect(html).toContain('aria-label="How it was made thread"')
    expect(html).toContain('Add how-it-was-made thread')
    expect(html).toContain('Seedance 2.5')
    expect(html).toContain('via Kie')
    expect(html).toContain('Exact final generation prompt')
    expect(html).toContain('posts as 1 reply')
    expect(html).toContain('src="/files/source-thumb.jpg"')
    expect(html).toContain('aria-label="Credits"')
    expect(html).toContain('Original video by @source https://x.com/source/status/123')
    expect(html).not.toContain('Thread options')
  })
})

describe('X post review draft', () => {
  it('reads and revises all supported post options', () => {
    const params = {
      asset_id: 'video-source',
      text: 'Original message',
      scheduled_for: '2099-08-25T03:00:00.000Z',
      orientation: 'portrait',
    }

    expect(xPostDraftFromParams(params)).toEqual({
      postText: 'Original message',
      scheduledFor: '2099-08-25T03:00:00.000Z',
      orientation: 'portrait',
      followups: [],
    })
    expect(reviseXPostParams(params, {
      postText: '',
      scheduledFor: null,
      orientation: null,
    })).toEqual({ asset_id: 'video-source' })
    expect(reviseXPostParams(params, {
      postText: 'Edited message',
      scheduledFor: '2099-09-01T04:30:00.000Z',
      orientation: 'landscape',
    })).toEqual({
      asset_id: 'video-source',
      text: 'Edited message',
      scheduled_for: '2099-09-01T04:30:00.000Z',
      orientation: 'landscape',
    })
  })

  it('validates the character limit and scheduled time', () => {
    const now = Date.parse('2099-08-25T03:00:00.000Z')
    expect(xPostDraftError({
      postText: 'x'.repeat(281),
      scheduledFor: null,
      orientation: null,
      followups: [],
    }, now)).toBe('Message is 1 character too long.')
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: '',
      orientation: null,
      followups: [],
    }, now)).toBe('Choose a valid date and time.')
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: '2099-08-25T02:59:00.000Z',
      orientation: null,
      followups: [],
    }, now)).toBe('Scheduled time must be in the future.')
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: '2099-08-25T04:00:00.000Z',
      orientation: null,
      followups: [],
    }, now)).toBeNull()
  })

  it('round-trips and validates editable thread replies', () => {
    const params = reviseXPostFollowups({ asset_id: 'video-source' }, [{
      text: 'Exact generation prompt',
      imageAssetIds: ['image-1', 'image-2'],
    }])
    expect(params).toEqual({
      asset_id: 'video-source',
      followups: [{
        text: 'Exact generation prompt',
        image_asset_ids: ['image-1', 'image-2'],
      }],
    })
    expect(xPostDraftFromParams(params).followups).toEqual([{
      text: 'Exact generation prompt',
      imageAssetIds: ['image-1', 'image-2'],
    }])
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: null,
      orientation: null,
      followups: [{ text: 'x'.repeat(281), imageAssetIds: [] }],
    })).toBe('Follow-up 1 is 1 character too long.')
  })

  it('round-trips local date-time inputs and chooses a rounded default', () => {
    const iso = '2099-08-25T03:00:00.000Z'
    const local = xPostLocalDateTimeValue(iso)
    expect(xPostIsoDateTimeValue(local)).toBe(iso)
    expect(defaultXPostScheduledFor(
      Date.parse('2099-08-25T03:01:00.000Z'),
    )).toBe('2099-08-25T04:05:00.000Z')
  })
})

describe('PostToXBody X connection notice', () => {
  const draft = {
    postText: 'hello',
    scheduledFor: null,
    orientation: null,
    followups: [],
  }

  function render(connection: Parameters<typeof PostToXBody>[0]['connection']): string {
    return renderToStaticMarkup(createElement(PostToXBody, {
      asset: null,
      busy: false,
      connection,
      draft,
      onChange: ignoreChange,
      onConnect: ignoreChange,
      prompt: 'post @b2 to X',
      settings: [],
      sourceLabel: '@b2',
    }))
  }

  it('offers to connect when no X account is linked', () => {
    const html = render({
      ...initialXConnectionState,
      status: {
        connected: false,
        pending: false,
        hasCredentials: true,
        error: null,
        expiresAt: null,
      },
    })
    expect(html).toContain('aria-label="X connection"')
    expect(html).toContain('Not connected')
    expect(html).toContain('Connect X</button>')
  })

  it('stays quiet when the account is connected or the status is unknown', () => {
    expect(render({
      ...initialXConnectionState,
      status: {
        connected: true,
        pending: false,
        hasCredentials: true,
        error: null,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    })).not.toContain('aria-label="X connection"')
    expect(render(initialXConnectionState)).not.toContain('aria-label="X connection"')
    expect(render(undefined)).not.toContain('aria-label="X connection"')
  })
})

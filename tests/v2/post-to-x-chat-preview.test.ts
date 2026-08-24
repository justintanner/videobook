import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PostToXChatPreview } from '../../src/components/videobook/PostToXChatPreview'
import {
  defaultXPostScheduledFor,
  reviseXPostParams,
  xPostDraftError,
  xPostDraftFromParams,
  xPostIsoDateTimeValue,
  xPostLocalDateTimeValue,
} from '../../src/videobook/x-post-review'

const ignoreChange = () => undefined

describe('PostToXChatPreview', () => {
  it('renders an image and the complete outbound message', () => {
    const postText = 'First line stays exact.\nSecond line is not truncated.'
    const html = renderToStaticMarkup(createElement(PostToXChatPreview, {
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
      },
      error: null,
      onChange: ignoreChange,
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
    const html = renderToStaticMarkup(createElement(PostToXChatPreview, {
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
      },
      error: null,
      onChange: ignoreChange,
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
    }, now)).toBe('Message is 1 character too long.')
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: '',
      orientation: null,
    }, now)).toBe('Choose a valid date and time.')
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: '2099-08-25T02:59:00.000Z',
      orientation: null,
    }, now)).toBe('Scheduled time must be in the future.')
    expect(xPostDraftError({
      postText: 'Ready',
      scheduledFor: '2099-08-25T04:00:00.000Z',
      orientation: null,
    }, now)).toBeNull()
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

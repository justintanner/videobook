import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PublishedPostInspectorDetails,
  PublishedPostTileChrome,
} from '../../src/components/videobook/PublishedPostChrome'

const postedInputs = {
  sourceOperation: 'post_to_x',
  tweetId: 'TWEET_99',
  tweetUrl: 'https://x.com/i/web/status/TWEET_99',
  postedAt: '2026-09-04T12:00:00.000Z',
  status: 'posted' as const,
  replies: [
    { tweetId: 'REPLY_1', tweetUrl: 'https://x.com/i/web/status/REPLY_1' },
  ],
}

describe('published post chrome', () => {
  it('renders the Posted to X badge, tweet link, time, and reply count on the tile', () => {
    const html = renderToStaticMarkup(createElement(PublishedPostTileChrome, {
      inputs: postedInputs,
    }))
    expect(html).toContain('Posted to X')
    expect(html).toContain('href="https://x.com/i/web/status/TWEET_99"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('2026-09-04 12:00:00 UTC')
    expect(html).toContain('1 reply')
  })

  it('renders inspector root/reply urls and followup_error for partially_posted', () => {
    const html = renderToStaticMarkup(createElement(PublishedPostInspectorDetails, {
      inputs: {
        ...postedInputs,
        status: 'partially_posted',
        followupError: { replyNumber: 2, message: 'Temporary X error' },
      },
    }))
    expect(html).toContain('Posted to X')
    expect(html).toContain('href="https://x.com/i/web/status/TWEET_99"')
    expect(html).toContain('href="https://x.com/i/web/status/REPLY_1"')
    expect(html).toContain('Follow-up 2 failed: Temporary X error')
  })
})

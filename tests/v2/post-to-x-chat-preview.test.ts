import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PostToXChatPreview } from '../../src/components/videobook/PostToXChatPreview'

describe('PostToXChatPreview', () => {
  it('renders an image and the complete outbound message', () => {
    const postText = 'First line stays exact.\nSecond line is not truncated.'
    const html = renderToStaticMarkup(createElement(PostToXChatPreview, {
      asset: {
        type: 'image',
        mediaUrl: '/files/image-original.png',
        thumbnailUrl: '/files/image-thumbnail.jpg',
      },
      postText,
      sourceLabel: '@b2',
    }))

    expect(html).toContain('aria-label="X post preview"')
    expect(html).toContain('src="/files/image-original.png"')
    expect(html).toContain('alt="@b2 post preview"')
    expect(html).toContain(postText)
    expect(html).toContain(`${postText.length}/280 characters`)
    expect(html).not.toContain('<video')
  })

  it('renders video controls and a media-only message state', () => {
    const html = renderToStaticMarkup(createElement(PostToXChatPreview, {
      asset: {
        type: 'video',
        mediaUrl: '/files/video-original.mp4',
        thumbnailUrl: '/files/video-poster.jpg',
      },
      postText: '',
      sourceLabel: '@a1',
    }))

    expect(html).toContain('<video')
    expect(html).toContain('src="/files/video-original.mp4"')
    expect(html).toContain('poster="/files/video-poster.jpg"')
    expect(html).toContain('controls=""')
    expect(html).toContain('No message — media only')
    expect(html).toContain('0/280 characters')
  })
})

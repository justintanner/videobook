import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MediaLibraryAssetPreview } from '../../src/components/videobook/MediaLibraryAssetPreview'

describe('MediaLibraryAssetPreview', () => {
  it('uses video markup instead of treating an MP4 as an image', () => {
    const html = renderToStaticMarkup(createElement(MediaLibraryAssetPreview, {
      eager: true,
      asset: {
        type: 'video',
        mediaUrl: '/files/book/vid-source/original.mp4',
        thumbnailUrl: null,
        duration: 30,
      },
    }))

    expect(html).toContain('<video')
    expect(html).toContain('src="/files/book/vid-source/original.mp4"')
    expect(html).toContain('preload="metadata"')
    expect(html).not.toContain('<img')
  })

  it('defers video sources while preserving preview geometry by default', () => {
    const html = renderToStaticMarkup(createElement(MediaLibraryAssetPreview, {
      asset: {
        type: 'video',
        mediaUrl: '/files/book/vid-source/original.mp4',
        thumbnailUrl: null,
        duration: 30,
      },
    }))

    expect(html).toContain('media-library-asset-preview')
    expect(html).toContain('0:30')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('/files/book/vid-source/original.mp4')
  })

  it('prefers image thumbnails and keeps image media in img elements', () => {
    const videoHtml = renderToStaticMarkup(createElement(MediaLibraryAssetPreview, {
      asset: {
        type: 'video',
        mediaUrl: '/files/book/vid-source/original.mp4',
        thumbnailUrl: '/files/book/vid-source/original.jpg',
        duration: 30,
      },
    }))
    const imageHtml = renderToStaticMarkup(createElement(MediaLibraryAssetPreview, {
      asset: {
        type: 'image',
        mediaUrl: '/files/book/img-source/original.png',
        thumbnailUrl: null,
        duration: null,
      },
    }))

    expect(videoHtml).toContain('<img src="/files/book/vid-source/original.jpg"')
    expect(videoHtml).not.toContain('<video')
    expect(imageHtml).toContain('<img src="/files/book/img-source/original.png"')
  })

  it('renders a stable placeholder when media has no visual source', () => {
    const html = renderToStaticMarkup(createElement(MediaLibraryAssetPreview, {
      asset: {
        type: 'audio',
        mediaUrl: '/files/book/aud-source/original.mp3',
        thumbnailUrl: null,
        duration: 65,
      },
    }))

    expect(html).toContain('media-library-asset-placeholder')
    expect(html).toContain('1:05')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<video')
  })
})

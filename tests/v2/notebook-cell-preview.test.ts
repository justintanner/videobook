import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellMediaFrame } from '../../src/components/videobook/CellMediaFrame'
import {
  audioPreviewBadges,
  audioPreviewMeter,
  imagePreviewBadges,
  previewMetadataLabel,
  previewMeter,
  videoPreviewBadges,
} from '../../src/videobook/cell-preview'

function imageFrame(prompt: string | null, producerAddress?: string): string {
  const badges = imagePreviewBadges({
    width: 768,
    height: 1344,
    tool: 'Nano Banana Pro Text to Image',
    model: 'kie:nano-banana-pro',
    provenance: null,
  })
  return renderToStaticMarkup(createElement(CellMediaFrame, {
    address: '@a1',
    producerAddress,
    posterUrl: 'https://example.test/still.png',
    waveform: null,
    mediaUrl: 'https://example.test/still.png',
    playbackKind: null,
    alt: 'still',
    title: prompt ?? undefined,
    badges,
    meter: null,
    metadataLabel: previewMetadataLabel('Image', badges, null, prompt),
    pendingLabel: 'Poster pending',
    pendingIcon: null,
  }))
}

describe('image preview frame', () => {
  const prompt = 'A detailed prompt that should remain accessible without covering the image'

  it('draws the badge rail with dimensions, aspect ratio and generator', () => {
    const html = imageFrame(prompt)

    expect(html).toContain('class="cell-media-rail"')
    expect(html).toContain('role="group"')
    expect(html).toContain('Dimensions 768×1344')
    expect(html).toContain('Aspect ratio 9:16')
    expect(html).toContain('Generator Nano Banana Pro T2I')
    expect(html).toContain('>768×1344</span>')
    expect(html).toContain('>9:16</span>')
    expect(html).toContain('>Nano Banana Pro T2I</span>')
  })

  it('keeps the prompt in the tooltip and the announcement, never over the image', () => {
    const html = imageFrame(prompt)

    expect(html).toContain(`title="${prompt}"`)
    expect(html).toContain(`Prompt: ${prompt}`)
    expect(html).not.toContain(`>${prompt}<`)
  })

  it('paints the poster and offers no play control', () => {
    const html = imageFrame(null)

    expect(html).toContain('<img src="https://example.test/still.png"')
    expect(html).not.toContain('cell-media-play')
    expect(html).not.toContain('cell-media-progress')
  })

  it('omits the rail when the asset knows nothing about itself', () => {
    const html = renderToStaticMarkup(createElement(CellMediaFrame, {
      address: '@a1',
      posterUrl: 'https://example.test/still.png',
      waveform: null,
      mediaUrl: null,
      playbackKind: null,
      alt: 'still',
      badges: imagePreviewBadges({
        width: null,
        height: null,
        tool: null,
        model: null,
        provenance: null,
      }),
      meter: null,
      metadataLabel: 'Image metadata',
      pendingLabel: 'Poster pending',
      pendingIcon: null,
    }))

    expect(html).not.toContain('cell-media-rail')
  })
})

describe('video preview frame', () => {
  const badges = videoPreviewBadges({
    aspectRatio: '16:9',
    width: null,
    height: null,
    tool: null,
    model: 'veo-3-fast',
    provenance: null,
  })
  const meter = previewMeter(6)

  function videoFrame(posterUrl: string | null): string {
    return renderToStaticMarkup(createElement(CellMediaFrame, {
      address: '@b1',
      posterUrl,
      waveform: null,
      mediaUrl: 'https://example.test/clip.mp4',
      playbackKind: 'video',
      alt: 'source clip',
      badges,
      meter,
      metadataLabel: previewMetadataLabel('Video', badges, meter, null),
      pendingLabel: 'Poster pending',
      pendingIcon: null,
    }))
  }

  it('rests on the poster rather than a mounted video element', () => {
    const html = videoFrame('https://example.test/poster.jpg')

    expect(html).toContain('<img src="https://example.test/poster.jpg"')
    expect(html).not.toContain('<video')
  })

  it('times the clip in the corner meter and names the play control', () => {
    const html = videoFrame('https://example.test/poster.jpg')

    expect(html).toContain('class="cell-media-meter"')
    expect(html).toContain('>0:06</time>')
    expect(html).toContain('aria-label="Play @b1"')
    expect(html).toContain('class="cell-media-progress"')
  })

  it('shows the pending face instead of an empty black square', () => {
    const html = videoFrame(null)

    expect(html).toContain('class="cell-media-pending-face"')
    expect(html).toContain('Poster pending')
  })
})

describe('audio preview frame', () => {
  function audioFrame(waveform: number[]): string {
    const input = {
      audioInfo: {
        channelLayout: 'stereo',
        channels: 2,
        codec: 'aac',
        durationSeconds: 12,
        sampleRateHz: 48_000,
      },
      durationSeconds: 12,
      hasOutput: true,
      inputs: { audioRole: 'scene' },
    }
    const badges = audioPreviewBadges(input)
    const meter = audioPreviewMeter(input)
    return renderToStaticMarkup(createElement(CellMediaFrame, {
      address: '@b4',
      posterUrl: null,
      waveform,
      mediaUrl: 'https://example.test/score.mp3',
      playbackKind: 'audio',
      alt: 'score',
      badges,
      meter,
      metadataLabel: previewMetadataLabel('Audio', badges, meter, null),
      pendingLabel: 'Waveform pending',
      pendingIcon: null,
    }))
  }

  it('draws the peaks as the poster, with the same rail and meter', () => {
    const html = audioFrame([0.1, 0.8, 0.4, 1, 0.2, 0.6])

    expect(html).toContain('class="cell-waveform"')
    expect(html).toContain('class="cell-waveform-bars"')
    expect(html).toContain('>Scene audio</span>')
    expect(html).toContain('>48 kHz</span>')
    expect(html).toContain('>stereo</span>')
    expect(html).toContain('>0:12</time>')
    expect(html).toContain('aria-label="Play @b4"')
  })

  it('leaves the native audio player out of the grid', () => {
    expect(audioFrame([0.5, 0.5])).not.toContain('<audio')
  })

  it('falls back to a flat run while the peaks are still being extracted', () => {
    const html = audioFrame([])

    expect(html).toContain('cell-waveform-pending')
    expect(html).toContain('Waveform pending')
    expect(html).toContain('>Scene audio</span>')
  })
})


describe('media source chip', () => {
  it('shows the producer before the other badges', () => {
    const html = imageFrame(null, '@b1')
    expect(html).toContain('title="Source @b1">↳ @b1</span>')
    expect(html.indexOf('↳ @b1')).toBeLessThan(html.indexOf('>768×1344</span>'))
  })

  it('omits the chip for media without a producer', () => {
    expect(imageFrame(null)).not.toContain('cell-media-source')
  })
})

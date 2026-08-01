import { describe, expect, it } from 'vitest'
import {
  assetMentionMetadata,
  assetMentionSuggestions,
  notebookMentionAssets,
  type AssetMentionCandidate,
} from '../../src/videobook/mention-suggestions'

function mentionAsset(
  id: string,
  artifactId: string,
  overrides: Partial<AssetMentionCandidate> = {},
): AssetMentionCandidate {
  return {
    id,
    artifactId,
    type: 'video',
    mediaUrl: `/files/book/${id}/original.mp4`,
    thumbnailUrl: `/files/book/${id}/original.jpg`,
    width: 1920,
    height: 1080,
    duration: 30,
    status: 'ready',
    ...overrides,
  }
}

describe('asset mention suggestions', () => {
  it('uses only deduplicated current outputs from the open notebook', () => {
    const currentVideo = mentionAsset('vid-current', 'artifact-current')
    const currentImage = mentionAsset('img-current', 'artifact-image', {
      type: 'image',
    })
    const olderVersion = mentionAsset('vid-older', 'artifact-older')
    const unrelated = mentionAsset('vid-unrelated', 'artifact-unrelated')

    expect(notebookMentionAssets([
      { outputArtifactId: currentVideo.artifactId },
      {},
      { outputArtifactId: currentVideo.artifactId },
      { outputArtifactId: 'artifact-missing' },
      { outputArtifactId: currentImage.artifactId },
    ], [unrelated, olderVersion, currentImage, currentVideo])).toEqual([
      currentVideo,
      currentImage,
    ])
  })

  it('filters case-insensitively and retains the selected asset metadata', () => {
    const video = mentionAsset('vid-Dance-Move', 'artifact-video')
    const image = mentionAsset('img-cover', 'artifact-image', { type: 'image' })

    expect(assetMentionSuggestions([video, image], 'extract @dance')).toEqual([{
      value: '@vid-Dance-Move',
      label: '@vid-Dance-Move',
      asset: video,
      type: 'asset',
    }])
    expect(assetMentionSuggestions([video], 'no active mention')).toEqual([])
  })

  it('caps the visible candidate list at twelve assets', () => {
    const assets = Array.from({ length: 14 }, (_, index) =>
      mentionAsset(`vid-${index + 1}`, `artifact-${index + 1}`))

    expect(assetMentionSuggestions(assets, '@')).toHaveLength(12)
    expect(assetMentionSuggestions(assets, '@').at(-1)?.label).toBe('@vid-12')
  })

  it('formats available media metadata and surfaces non-ready status', () => {
    expect(assetMentionMetadata(mentionAsset('vid-portrait', 'artifact-video', {
      width: 1080,
      height: 1920,
      duration: 29,
      status: 'processing_media',
    }))).toEqual(['VIDEO', '1080×1920', '0:29', 'PROCESSING MEDIA'])

    expect(assetMentionMetadata(mentionAsset('aud-voice', 'artifact-audio', {
      type: 'audio',
      width: null,
      height: null,
      duration: null,
    }))).toEqual(['AUDIO'])
  })
})

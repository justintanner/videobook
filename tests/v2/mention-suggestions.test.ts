import { describe, expect, it } from 'vitest'
import {
  assetMentionMetadata,
  assetMentionSuggestions,
  notebookMentionAssets,
  resolveNotebookMentionAliases,
  type AssetMentionCandidate,
  type AssetMentionRecord,
} from '../../src/videobook/mention-suggestions'

function mentionAsset(
  id: string,
  artifactId: string,
  overrides: Partial<AssetMentionRecord> = {},
): AssetMentionRecord {
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

function mentionCandidate(
  cellSlug: string,
  assetSlug: string,
  artifactId: string,
  overrides: Partial<AssetMentionCandidate> = {},
): AssetMentionCandidate {
  const asset = mentionAsset(assetSlug, artifactId, overrides)
  return notebookMentionAssets(
    [{ slug: cellSlug, type: asset.type, outputArtifactId: artifactId }],
    [asset],
  )[0]!
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
      { slug: 'vid-01', type: 'video', outputArtifactId: currentVideo.artifactId },
      { slug: 'empty', type: 'image' },
      { slug: 'vid-copy', type: 'video', outputArtifactId: currentVideo.artifactId },
      { slug: 'missing', type: 'image', outputArtifactId: 'artifact-missing' },
      { slug: 'img-01', type: 'image', outputArtifactId: currentImage.artifactId },
    ], [unrelated, olderVersion, currentImage, currentVideo])).toEqual([
      expect.objectContaining({
        cellSlug: 'vid-01',
        assetSlug: currentVideo.id,
        artifactId: currentVideo.artifactId,
      }),
      expect.objectContaining({
        cellSlug: 'img-01',
        assetSlug: currentImage.id,
        artifactId: currentImage.artifactId,
      }),
    ])
  })

  it('prefers a concrete media cell over an action sharing its artifact', () => {
    const frame = mentionAsset('img-frame-source', 'artifact-frame', {
      type: 'image',
    })

    expect(notebookMentionAssets([
      {
        slug: 'extract-frame-01',
        type: 'extract_frame',
        outputArtifactId: frame.artifactId,
      },
      {
        slug: 'img-01',
        type: 'image',
        outputArtifactId: frame.artifactId,
      },
    ], [frame])).toEqual([
      expect.objectContaining({
        cellSlug: 'img-01',
        assetSlug: frame.id,
        artifactId: frame.artifactId,
      }),
    ])
  })

  it('uses the notebook cell slug while retaining backing asset metadata', () => {
    const video = mentionCandidate(
      'vid-Dance-Move',
      'vid-yt-source-2',
      'artifact-video',
    )
    const image = mentionCandidate('img-cover', 'img-source', 'artifact-image', {
      type: 'image',
    })

    expect(assetMentionSuggestions([video, image], 'extract @dance')).toEqual([{
      value: '@vid-Dance-Move',
      label: '@vid-Dance-Move',
      asset: video,
      type: 'asset',
    }])
    expect(assetMentionSuggestions([video], 'no active mention')).toEqual([])
  })

  it('offers only images in image-generation reference context', () => {
    const video = mentionCandidate(
      'vid-01',
      'vid-source',
      'artifact-video',
    )
    const image = mentionCandidate('img-01', 'img-source', 'artifact-image', {
      type: 'image',
    })

    expect(assetMentionSuggestions(
      [video, image],
      'generate an image of @',
    ).map((suggestion) => suggestion.label)).toEqual(['@img-01'])
    expect(assetMentionSuggestions(
      [video, image],
      'combine @',
    ).map((suggestion) => suggestion.label)).toEqual(['@vid-01', '@img-01'])
  })

  it('caps the visible candidate list at twelve assets', () => {
    const assets = Array.from({ length: 14 }, (_, index) =>
      mentionCandidate(
        `vid-${index + 1}`,
        `vid-source-${index + 1}`,
        `artifact-${index + 1}`,
      ))

    expect(assetMentionSuggestions(assets, '@')).toHaveLength(12)
    expect(assetMentionSuggestions(assets, '@').at(-1)?.label).toBe('@vid-12')
  })

  it('formats available media metadata and surfaces non-ready status', () => {
    expect(assetMentionMetadata(mentionCandidate(
      'vid-portrait',
      'vid-source',
      'artifact-video',
      {
      width: 1080,
      height: 1920,
      duration: 29,
      status: 'processing_media',
      },
    ))).toEqual(['VIDEO', '1080×1920', '0:29', 'PROCESSING MEDIA'])

    expect(assetMentionMetadata(mentionCandidate(
      'aud-voice',
      'aud-source',
      'artifact-audio',
      {
        type: 'audio',
        width: null,
        height: null,
        duration: null,
      },
    ))).toEqual(['AUDIO'])
  })

  it('translates exact cell mentions at generic backend boundaries', () => {
    const video = mentionCandidate(
      'vid-01',
      'vid-yt-8gwzvebyrji-2',
      'artifact-video',
    )
    const image = mentionCandidate(
      'img-01',
      'img-generated-source',
      'artifact-image',
      { type: 'image' },
    )

    expect(resolveNotebookMentionAliases(
      'combine @VID-01 with @img-01 and leave @vid-010 alone',
      [video, image],
    )).toBe(
      'combine @vid-yt-8gwzvebyrji-2 with @img-generated-source and leave @vid-010 alone',
    )
  })
})

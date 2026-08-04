import { describe, expect, it } from 'vitest'
import {
  assetMentionMetadata,
  assetMentionSuggestions,
  applyNotebookMentionSuggestion,
  notebookAddressSuggestions,
  notebookCellRenamePlan,
  notebookMentionAssets,
  resolveNotebookMentionAliases,
  restoreNotebookMentionAliases,
  restoreSelectedNotebookMentionAliases,
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
  it('applies a canonical mention completion at the end of input', () => {
    expect(applyNotebookMentionSuggestion('use @A_', '@a2'))
      .toBe('use @a2')
    expect(applyNotebookMentionSuggestion('leave this alone', '@a2'))
      .toBe('leave this alone')
  })

  it('offers canonical occupied and empty grid addresses', () => {
    expect(notebookAddressSuggestions([
      { slot: { row: 0, column: 0 }, type: 'video' },
      { slot: { row: 25, column: 12 }, type: 'prompt' },
    ], '@a')).toEqual([
      {
        value: '@a1',
        label: '@a1',
        description: 'VIDEO cell',
        type: 'cell',
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        value: `@a${index + 2}`,
        label: `@a${index + 2}`,
        description: 'Empty grid square',
        type: 'cell',
      })),
    ])
    expect(notebookAddressSuggestions([
      { slot: { row: 25, column: 12 }, type: 'prompt' },
    ], '@Z13')).toEqual([{
      value: '@z13',
      label: '@z13',
      description: 'PROMPT cell',
      type: 'cell',
    }])
  })

  it('maps canonical cell addresses to backing asset aliases', () => {
    const asset = mentionAsset('vid-source', 'artifact-video')
    const candidate = notebookMentionAssets([{
      slug: 'internal-video-slug',
      slot: { row: 1, column: 2 },
      type: 'video',
      outputArtifactId: asset.artifactId,
    }], [asset])[0]!

    expect(candidate.cellAddress).toBe('b3')
    expect(resolveNotebookMentionAliases(
      'combine @B3 with @b4',
      [candidate],
    )).toBe('combine @vid-source with @b4')
  })

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

  it('restores routed asset tags to visible notebook addresses', () => {
    const scene = {
      ...mentionCandidate(
        'img-scene',
        'img-generated-scene',
        'artifact-scene',
        { type: 'image' },
      ),
      cellAddress: 'a5',
    }
    const character = {
      ...mentionCandidate(
        'img-character',
        'img-fluffy-kitten',
        'artifact-character',
        { type: 'image' },
      ),
      cellAddress: 'a1',
    }

    expect(restoreNotebookMentionAliases(
      'scene @img-generated-scene, character @img-fluffy-kitten, fluffy kitten standing',
      [scene, character],
    )).toBe('scene @a5, character @a1, fluffy kitten standing')
  })

  it('restores a routed asset tag to the selected cell sharing its artifact', () => {
    const candidate = {
      ...mentionCandidate(
        'img-generated',
        'img-shared-output',
        'artifact-shared',
        { type: 'image' },
      ),
      cellAddress: 'a1',
    }

    expect(restoreSelectedNotebookMentionAliases(
      'restyle @img-shared-output',
      [candidate],
      [{
        id: 'cell-media',
        slug: 'img-media',
        slot: { row: 0, column: 1 },
        type: 'image',
        outputArtifactId: 'artifact-shared',
      }],
    )).toBe('restyle @a2')
  })

  it('plans a visible cell rename from a completed backing asset rename', () => {
    const candidate = mentionCandidate(
      'img-02',
      'img-extract-frame-first',
      'artifact-image',
      { type: 'image' },
    )
    const cells = [
      {
        id: 'cell-image',
        slug: 'img-02',
        type: 'image',
        outputArtifactId: 'artifact-image',
      },
      {
        id: 'cell-other',
        slug: 'img-other',
        type: 'image',
        outputArtifactId: 'artifact-other',
      },
    ]

    expect(notebookCellRenamePlan(
      'img-02',
      {
        old_asset_id: 'img-extract-frame-first',
        new_asset_id: 'img-hero-frame',
      },
      cells,
      [candidate],
    )).toEqual({
      cellId: 'cell-image',
      previousSlug: 'img-02',
      nextSlug: 'img-hero-frame',
      conflict: false,
    })
  })

  it('keeps raw asset renames asset-only and detects cell slug conflicts', () => {
    const candidate = mentionCandidate(
      'img-02',
      'img-source',
      'artifact-image',
      { type: 'image' },
    )
    const cells = [
      {
        id: 'cell-image',
        slug: 'img-02',
        type: 'image',
        outputArtifactId: 'artifact-image',
      },
      {
        id: 'cell-existing',
        slug: 'img-hero',
        type: 'image',
        outputArtifactId: 'artifact-existing',
      },
    ]
    const result = {
      old_asset_id: 'img-source',
      new_asset_id: 'img-hero',
    }

    expect(notebookCellRenamePlan(
      'img-source',
      result,
      cells,
      [candidate],
    )).toBeNull()
    expect(notebookCellRenamePlan(
      'img-02',
      result,
      cells,
      [candidate],
    )?.conflict).toBe(true)
  })
})

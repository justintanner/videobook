import { describe, expect, it } from 'vitest'
import {
  assetMentionMetadata,
  assetMentionSuggestions,
  applyNotebookMentionSuggestion,
  notebookAddressSuggestions,
  notebookMentionAssets,
  resolveNotebookMentionAliases,
  restoreNotebookMentionAliases,
  restoreSelectedNotebookMentionAliases,
  type AssetMentionCandidate,
  type AssetMentionRecord,
} from '../../src/videobook/mention-suggestions'
import type { NotebookGridSlot } from 'videobook-engine'

const VIDEO_ARTIFACT = '019fcc6b-0000-7000-8000-0000000000a1'
const IMAGE_ARTIFACT = '019fcc6b-0000-7000-8000-0000000000b2'
const AUDIO_ARTIFACT = '019fcc6b-0000-7000-8000-0000000000c3'

function artifactId(index: number): string {
  return `019fcc6b-0000-7000-8000-${String(index).padStart(12, '0')}`
}

function mentionAsset(
  id: string,
  overrides: Partial<AssetMentionRecord> = {},
): AssetMentionRecord {
  return {
    id,
    artifactId: id,
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
  slot: NotebookGridSlot,
  id: string,
  overrides: Partial<AssetMentionRecord> = {},
): AssetMentionCandidate {
  const asset = mentionAsset(id, overrides)
  return notebookMentionAssets(
    [{ slot, type: asset.type, outputArtifactId: asset.artifactId }],
    [asset],
  )[0]!
}

describe('asset mention suggestions', () => {
  it('applies a canonical mention completion at the end of input', () => {
    expect(applyNotebookMentionSuggestion('use @A', '@a2'))
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

  it('maps canonical cell addresses to backing artifact aliases', () => {
    const asset = mentionAsset(VIDEO_ARTIFACT)
    const candidate = notebookMentionAssets([{
      id: 'cell-video',
      slot: { row: 1, column: 2 },
      type: 'video',
      outputArtifactId: asset.artifactId,
    }], [asset])[0]!

    expect(candidate.cellAddress).toBe('b3')
    expect(resolveNotebookMentionAliases(
      'combine @B3 with @b4',
      [candidate],
    )).toBe(`combine @${VIDEO_ARTIFACT} with @b4`)
  })

  it('uses only deduplicated current outputs from the open notebook', () => {
    const currentVideo = mentionAsset(VIDEO_ARTIFACT)
    const currentImage = mentionAsset(IMAGE_ARTIFACT, { type: 'image' })
    const olderVersion = mentionAsset(artifactId(11))
    const unrelated = mentionAsset(artifactId(12))

    expect(notebookMentionAssets([
      {
        slot: { row: 0, column: 0 },
        type: 'video',
        outputArtifactId: currentVideo.artifactId,
      },
      { slot: { row: 0, column: 1 }, type: 'image' },
      {
        slot: { row: 0, column: 2 },
        type: 'video',
        outputArtifactId: currentVideo.artifactId,
      },
      {
        slot: { row: 0, column: 3 },
        type: 'image',
        outputArtifactId: artifactId(13),
      },
      {
        slot: { row: 0, column: 4 },
        type: 'image',
        outputArtifactId: currentImage.artifactId,
      },
    ], [unrelated, olderVersion, currentImage, currentVideo])).toEqual([
      expect.objectContaining({
        cellAddress: 'a1',
        artifactId: currentVideo.artifactId,
        type: 'video',
      }),
      expect.objectContaining({
        cellAddress: 'a5',
        artifactId: currentImage.artifactId,
        type: 'image',
      }),
    ])
  })

  it('prefers a concrete media cell over an action sharing its artifact', () => {
    const frame = mentionAsset(IMAGE_ARTIFACT, { type: 'image' })

    expect(notebookMentionAssets([
      {
        slot: { row: 0, column: 0 },
        type: 'extract_frame',
        outputArtifactId: frame.artifactId,
      },
      {
        slot: { row: 0, column: 1 },
        type: 'image',
        outputArtifactId: frame.artifactId,
      },
    ], [frame])).toEqual([
      expect.objectContaining({
        cellAddress: 'a2',
        artifactId: frame.artifactId,
        type: 'image',
      }),
    ])
  })

  it('uses the notebook cell address while retaining backing asset metadata', () => {
    const video = mentionCandidate({ row: 1, column: 2 }, VIDEO_ARTIFACT)
    const image = mentionCandidate({ row: 0, column: 0 }, IMAGE_ARTIFACT, {
      type: 'image',
    })

    expect(assetMentionSuggestions([video, image], 'extract @b')).toEqual([{
      value: '@b3',
      label: '@b3',
      asset: video,
      type: 'asset',
    }])
    expect(assetMentionSuggestions([video, image], 'extract @b')[0]?.asset)
      .toMatchObject({
        artifactId: VIDEO_ARTIFACT,
        mediaUrl: `/files/book/${VIDEO_ARTIFACT}/original.mp4`,
        thumbnailUrl: `/files/book/${VIDEO_ARTIFACT}/original.jpg`,
      })
    expect(assetMentionSuggestions([video], 'no active mention')).toEqual([])
  })

  it('offers only images in image-generation reference context', () => {
    const video = mentionCandidate({ row: 0, column: 0 }, VIDEO_ARTIFACT)
    const image = mentionCandidate({ row: 0, column: 1 }, IMAGE_ARTIFACT, {
      type: 'image',
    })

    expect(assetMentionSuggestions(
      [video, image],
      'generate an image of @',
    ).map((suggestion) => suggestion.label)).toEqual(['@a2'])
    expect(assetMentionSuggestions(
      [video, image],
      'combine @',
    ).map((suggestion) => suggestion.label)).toEqual(['@a1', '@a2'])
  })

  it('caps the visible candidate list at twelve assets', () => {
    const assets = Array.from({ length: 14 }, (_, index) =>
      mentionCandidate(
        { row: Math.floor(index / 13), column: index % 13 },
        artifactId(index + 1),
      ))

    expect(assetMentionSuggestions(assets, '@')).toHaveLength(12)
    expect(assetMentionSuggestions(assets, '@').at(-1)?.label).toBe('@a12')
  })

  it('formats available media metadata and surfaces non-ready status', () => {
    expect(assetMentionMetadata(mentionCandidate(
      { row: 0, column: 0 },
      VIDEO_ARTIFACT,
      {
        width: 1080,
        height: 1920,
        duration: 29,
        status: 'processing_media',
      },
    ))).toEqual(['VIDEO', '1080×1920', '0:29', 'PROCESSING MEDIA'])

    expect(assetMentionMetadata(mentionCandidate(
      { row: 0, column: 1 },
      AUDIO_ARTIFACT,
      {
        type: 'audio',
        width: null,
        height: null,
        duration: null,
      },
    ))).toEqual(['AUDIO'])
  })

  it('translates exact cell mentions at generic backend boundaries', () => {
    const video = mentionCandidate({ row: 0, column: 0 }, VIDEO_ARTIFACT)
    const image = mentionCandidate({ row: 0, column: 1 }, IMAGE_ARTIFACT, {
      type: 'image',
    })

    expect(resolveNotebookMentionAliases(
      'combine @A1 with @a2 and leave @a10 alone',
      [video, image],
    )).toBe(
      `combine @${VIDEO_ARTIFACT} with @${IMAGE_ARTIFACT} and leave @a10 alone`,
    )
  })

  it('restores routed asset tags to visible notebook addresses', () => {
    const scene = mentionCandidate({ row: 0, column: 4 }, IMAGE_ARTIFACT, {
      type: 'image',
    })
    const character = mentionCandidate({ row: 0, column: 0 }, artifactId(21), {
      type: 'image',
    })

    expect(restoreNotebookMentionAliases(
      `scene @${scene.artifactId}, character @${character.artifactId}, fluffy kitten standing`,
      [scene, character],
    )).toBe('scene @a5, character @a1, fluffy kitten standing')
  })

  it('restores a routed asset tag to the selected cell sharing its artifact', () => {
    const candidate = mentionCandidate({ row: 0, column: 0 }, IMAGE_ARTIFACT, {
      type: 'image',
    })

    expect(restoreSelectedNotebookMentionAliases(
      `restyle @${candidate.artifactId}`,
      [candidate],
      [{
        id: 'cell-media',
        slot: { row: 0, column: 1 },
        type: 'image',
        outputArtifactId: IMAGE_ARTIFACT,
      }],
    )).toBe('restyle @a2')
  })
})

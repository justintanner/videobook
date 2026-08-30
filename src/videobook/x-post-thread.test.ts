import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  buildXPostThreadReplies,
  dedupeXPostAttributions,
  discoverXPostThreadGraph,
  initialXPostThreadReview,
  selectXPostGenerationPrompt,
  xPostSourceAttribution,
} from './x-post-thread'

function cell(
  id: string,
  type: NotebookCell['type'],
  row: number,
  outputArtifactId?: string,
): NotebookCell {
  return {
    id,
    type,
    label: id,
    slot: { row, column: 0 },
    ...(outputArtifactId ? { outputArtifactId } : {}),
  }
}

function document(): NotebookDocument {
  const sourceImage = cell('source-image', 'image', 0, 'img-source')
  const originalVideo = cell('original-video', 'video', 1, 'vid-original')
  const producer = {
    ...cell('generate-video', 'generate_video', 2),
    prompt: 'producer prompt',
    inputs: { resolvedPrompt: 'producer resolved prompt' },
  }
  const output = cell('generated-output', 'video', 3, 'vid-generated')
  const final = cell('final-video', 'video', 4, 'vid-final')
  return {
    id: 'notebook',
    name: 'Main',
    createdAt: '2026-08-30T00:00:00.000Z',
    cells: [sourceImage, originalVideo, producer, output, final],
    edges: [
      { id: 'image-input', source: sourceImage.id, target: producer.id, targetInput: 'image' },
      { id: 'generation-output', source: producer.id, target: output.id, targetInput: 'media' },
      { id: 'generated-input', source: output.id, target: final.id, targetInput: 'video' },
      { id: 'original-input', source: originalVideo.id, target: final.id, targetInput: 'video' },
    ],
  }
}

describe('X post thread provenance', () => {
  it('finds only the final generation frontier and its direct source artifacts', () => {
    const graph = discoverXPostThreadGraph(document(), 'vid-final')
    expect(graph.steps).toEqual([{
      id: 'generate-video',
      producerCellId: 'generate-video',
      outputCellId: 'generated-output',
      outputArtifactId: 'vid-generated',
      producerPrompt: 'producer prompt',
      producerResolvedPrompt: 'producer resolved prompt',
      sourceArtifactIds: ['img-source'],
    }])
    expect(graph.upstreamArtifactIds).toEqual(expect.arrayContaining([
      'vid-final',
      'vid-generated',
      'vid-original',
      'img-source',
    ]))
  })

  it('prefers the matching completed attempt prompt before stored fallbacks', () => {
    expect(selectXPostGenerationPrompt({
      attempts: [
        {
          status: 'completed',
          artifactId: 'old-output',
          resolvedPrompt: 'old exact prompt',
        },
        {
          status: 'completed',
          artifactId: 'current-output',
          resolvedPrompt: 'current exact prompt',
        },
      ],
      outputArtifactId: 'current-output',
      outputAssetPrompt: 'asset prompt',
      producerResolvedPrompt: 'producer resolved',
      producerPrompt: 'producer prompt',
    })).toBe('current exact prompt')
  })

  it('keeps only YouTube and X originals and derives mentions from status URLs', () => {
    const youtube = xPostSourceAttribution('yt', {
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
      uploader: 'Original Filmmaker',
    })
    const xStatus = xPostSourceAttribution('x', {
      source_url: 'https://twitter.com/source_owner/status/12345?ref=test',
      uploader: 'Source Owner',
    })
    const xProfile = xPostSourceAttribution('profile', {
      source_url: 'https://x.com/unverified_name',
      uploader: '@unverified_name',
    })
    const unsupported = xPostSourceAttribution('site', {
      source_url: 'https://example.com/video',
    })

    expect(youtube).toMatchObject({
      label: 'Original Filmmaker',
      xHandle: null,
    })
    expect(xStatus).toMatchObject({
      url: 'https://x.com/source_owner/status/12345',
      xHandle: 'source_owner',
    })
    expect(xProfile).toMatchObject({ label: 'unverified_name', xHandle: null })
    expect(unsupported).toBeNull()
    expect(dedupeXPostAttributions([
      youtube!,
      { ...youtube!, id: 'duplicate' },
      xStatus!,
    ])).toEqual([youtube, xStatus])
  })

  it('splits exact prompts and images safely and leaves attribution at the tail', () => {
    const prompt = Array.from({ length: 90 }, (_, index) => `word-${index}`).join(' ')
    const context = {
      steps: [{
        id: 'generation',
        prompt,
        images: Array.from({ length: 5 }, (_, index) => ({
          assetId: `image-${index}`,
          label: `@a${index + 1}`,
          mediaUrl: `/image-${index}.png`,
          thumbnailUrl: null,
        })),
      }],
      attributions: [
        {
          id: 'youtube',
          label: 'Original Channel',
          url: 'https://www.youtube.com/watch?v=abc',
          xHandle: null,
        },
        {
          id: 'x',
          label: 'Source',
          url: 'https://x.com/source/status/123',
          xHandle: 'source',
        },
      ],
    }
    const disabled = initialXPostThreadReview(context)
    expect(buildXPostThreadReplies(disabled)).toEqual([])

    const enabled = {
      ...disabled,
      options: { ...disabled.options, enabled: true },
    }
    const replies = buildXPostThreadReplies(enabled)
    expect(replies.length).toBeGreaterThan(3)
    expect(replies.every((reply) => reply.text.length <= 280)).toBe(true)
    expect(replies.every((reply) => reply.imageAssetIds.length <= 4)).toBe(true)
    expect(replies[0].imageAssetIds).toHaveLength(4)
    expect(replies.some((reply) => reply.imageAssetIds.includes('image-4'))).toBe(true)
    expect(replies.at(-1)?.text).toContain('@source https://x.com/source/status/123')

    const firstReplyId = replies[0].id
    const edited = {
      ...enabled,
      textOverrides: { [firstReplyId]: 'Edited exact reply' },
    }
    const hidden = {
      ...edited,
      options: { ...edited.options, includePrompt: false },
    }
    expect(buildXPostThreadReplies(hidden).some((reply) =>
      reply.id === firstReplyId)).toBe(false)
    expect(buildXPostThreadReplies(edited)[0].text).toBe('Edited exact reply')
    expect(buildXPostThreadReplies({
      ...enabled,
      options: {
        enabled: true,
        includePrompt: false,
        includeSourceImages: false,
        includeAttribution: false,
      },
    })).toEqual([])
  })
})

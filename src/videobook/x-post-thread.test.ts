import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  buildXPostThreadReplies,
  dedupeXPostAttributions,
  discoverXPostThreadGraph,
  initialXPostThreadReview,
  readableXPostPrompt,
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
  it('follows duplicate and routed-edit provenance recorded only in cell inputs', () => {
    const base = document()
    const duplicate = {
      ...cell('duplicate-video', 'video', 5, 'vid-duplicate'),
      inputs: {
        sourceOperation: 'duplicate_asset',
        sourceArtifactId: 'vid-generated',
        state: 'completed',
      },
    }
    const trimmed = {
      ...cell('trimmed-video', 'video', 6, 'vid-trimmed'),
      inputs: { sourceOperation: 'extract_video_clip', source_asset_id: 'vid-duplicate' },
    }
    const copy = {
      ...cell('copied-video', 'video', 7, 'vid-copy'),
      inputs: {
        sourceOperation: 'duplicate_asset',
        sourceArtifactId: 'vid-trimmed',
        state: 'completed',
      },
    }
    const graph = discoverXPostThreadGraph(
      { ...base, cells: [...base.cells, duplicate, trimmed, copy] },
      'vid-copy',
    )
    expect(graph.steps).toHaveLength(1)
    expect(graph.steps[0]).toMatchObject({
      id: 'generate-video',
      outputCellId: 'generated-output',
      outputArtifactId: 'vid-generated',
      producerResolvedPrompt: 'producer resolved prompt',
      sourceArtifactIds: ['img-source'],
    })
    expect(graph.upstreamArtifactIds).toEqual(expect.arrayContaining([
      'vid-copy',
      'vid-trimmed',
      'vid-duplicate',
      'vid-generated',
      'img-source',
    ]))
    expect(graph.upstreamArtifactIds).not.toContain('vid-original')
  })

  it('rewrites notebook mentions into readable labels for public replies', () => {
    const prompt = 'dance from @01a02773-e0fe-71da-9de9-c77352765a8a scene @b5, '
      + 'again @B5 and @01a0aaaa-0000-7000-8000-000000000000; keep @Video 1 and @zz9 as typed'
    expect(readableXPostPrompt(prompt, [
      { reference: '01a02773-e0fe-71da-9de9-c77352765a8a', type: 'video' },
      { reference: 'b5', type: 'image' },
    ])).toBe('dance from [video 1] scene [image 1], '
      + 'again [image 1] and [source 1]; keep @Video 1 and @zz9 as typed')
    expect(readableXPostPrompt('no mentions here', [])).toBe('no mentions here')
  })

  it('credits the concrete YouTube video rather than its playlist page', () => {
    expect(xPostSourceAttribution('yt', {
      webpage_url: 'https://www.youtube.com/playlist?list=PLWxZwASNHB04',
      source_url: 'https://youtu.be/iZlOQMYjdPg?list=PLWxZwASNHB04',
      uploader: 'Stephanie Morris',
    })).toEqual({
      id: 'yt:https://youtu.be/iZlOQMYjdPg',
      label: 'Stephanie Morris',
      url: 'https://youtu.be/iZlOQMYjdPg',
      xHandle: null,
    })
    expect(xPostSourceAttribution('shorts', {
      webpage_url: 'https://www.youtube.com/shorts/abcDEF123?feature=share',
    })?.url).toBe('https://www.youtube.com/shorts/abcDEF123')
    expect(xPostSourceAttribution('playlist', {
      webpage_url: 'https://www.youtube.com/playlist?list=PL1#top',
    })).toMatchObject({
      label: 'YouTube',
      url: 'https://www.youtube.com/playlist?list=PL1',
    })
  })
  it('never lets a prompt chunk exceed the limit when the cut lands on a space', () => {
    const prefix = 'How I made this video — prompt:\n'
    const capacity = 280 - prefix.length
    const prompt = `${'x'.repeat(capacity)} ${'y'.repeat(40)}`
    const review = initialXPostThreadReview({
      steps: [{ id: 'generation', prompt, images: [] }],
      attributions: [],
    })
    const replies = buildXPostThreadReplies({
      ...review,
      options: { ...review.options, enabled: true },
    })
    expect(replies.map((reply) => reply.text.length)).toEqual([280, 63])
    expect(replies[1]?.text).toBe(`Prompt continued (2):\n ${'y'.repeat(40)}`)
  })
})

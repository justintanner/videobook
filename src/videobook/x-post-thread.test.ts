import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  buildXPostThreadReplies,
  dedupeXPostSourceCredits,
  discoverXPostThreadGraph,
  initialXPostThreadReview,
  readableXPostPrompt,
  selectXPostGenerationModel,
  selectXPostGenerationPrompt,
  xPostSourceCredit,
  xPostThreadHasDetails,
  xPostThreadPrompt,
  type XPostThreadImage,
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
    provider: 'kie',
    model: 'Seedance2MiniInputSchema',
    tool: 'generate_kie_seedance_2_5_video',
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

const SEEDANCE_ACTION = {
  tool: 'generate_kie_seedance_2_5_video',
  title: 'Seedance 2.5',
  providerLabel: 'Kie',
}

const SEEDANCE_PRODUCER = {
  producerTool: 'generate_kie_seedance_2_5_video',
  producerModel: 'Seedance2MiniInputSchema',
  producerProvider: 'kie',
}

function image(index: number): XPostThreadImage {
  return {
    assetId: `image-${index}`,
    label: `@a${index + 1}`,
    mediaUrl: `/image-${index}.png`,
    thumbnailUrl: null,
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
      producerTool: 'generate_kie_seedance_2_5_video',
      producerModel: 'Seedance2MiniInputSchema',
      producerProvider: 'kie',
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

  it('names the model from the attempt that produced the output, then the producer cell', () => {
    expect(selectXPostGenerationModel({
      attempts: [
        {
          status: 'completed',
          artifactId: 'other-output',
          tool: 'generate_kie_veo_3_1_video',
          model: 'veo-3.1',
          provider: 'kie',
        },
        {
          status: 'completed',
          artifactId: 'current-output',
          tool: 'generate_fal_kling_3_0_omni_video',
          model: 'kling-3.0-omni',
          provider: 'fal',
        },
      ],
      outputArtifactId: 'current-output',
      ...SEEDANCE_PRODUCER,
      actions: [SEEDANCE_ACTION],
    })).toEqual({ label: 'kling-3.0-omni', provider: 'fal' })
    expect(selectXPostGenerationModel({
      attempts: [],
      outputArtifactId: 'current-output',
      ...SEEDANCE_PRODUCER,
      actions: [SEEDANCE_ACTION],
    })).toEqual({ label: 'Seedance 2.5', provider: 'Kie' })
    expect(selectXPostGenerationModel({
      attempts: [],
      outputArtifactId: 'current-output',
      ...SEEDANCE_PRODUCER,
      actions: [],
    })).toEqual({ label: 'Seedance2MiniInputSchema', provider: 'kie' })
    expect(selectXPostGenerationModel({
      attempts: [],
      outputArtifactId: null,
      producerTool: null,
      producerModel: null,
      producerProvider: null,
      actions: [],
    })).toBeNull()
  })

  it('posts one reply with the heading, the trimmed prompt and the first four images', () => {
    const heading = 'Made with Seedance 2.5 via Kie. Prompt:\n'
    const prompt = Array.from({ length: 90 }, (_, index) => `word-${index}`).join(' ')
    const step = {
      id: 'generation',
      prompt,
      model: { label: 'Seedance 2.5', provider: 'Kie' },
      images: Array.from({ length: 5 }, (_, index) => image(index)),
    }
    const context = { steps: [step], credits: [] }
    expect(xPostThreadHasDetails(context)).toBe(true)
    expect(xPostThreadHasDetails({
      steps: [{ ...step, prompt: ' ', images: [] }],
      credits: [],
    })).toBe(false)
    expect(initialXPostThreadReview({ steps: [], credits: [] }).options.enabled).toBe(false)

    const review = initialXPostThreadReview(context)
    expect(review.options.enabled).toBe(true)
    expect(buildXPostThreadReplies({ ...review, options: { enabled: false } })).toEqual([])

    const replies = buildXPostThreadReplies(review)
    expect(replies).toHaveLength(1)
    const reply = replies[0]!
    expect(reply.text.startsWith(`${heading}word-0 word-1 `)).toBe(true)
    expect(reply.text.endsWith('…')).toBe(true)
    expect(reply.text).not.toContain('word-89')
    expect(reply.text.length).toBeLessThan(280)
    expect(reply.text).toBe(`${heading}${xPostThreadPrompt(review, step)}`)
    expect(reply.imageAssetIds).toEqual(['image-0', 'image-1', 'image-2', 'image-3'])

    const edited = { ...review, promptOverrides: { generation: 'Edited exact prompt' } }
    expect(buildXPostThreadReplies(edited)).toEqual([{
      id: 'step:generation',
      stepId: 'generation',
      text: `${heading}Edited exact prompt`,
      imageAssetIds: ['image-0', 'image-1', 'image-2', 'image-3'],
      images: step.images.slice(0, 4),
    }])
    expect(buildXPostThreadReplies({
      ...review,
      promptOverrides: { generation: '   ' },
    })).toMatchObject([{
      text: 'Input images for this video:',
      imageAssetIds: ['image-0', 'image-1', 'image-2', 'image-3'],
    }])
    expect(buildXPostThreadReplies({
      ...review,
      context: { steps: [{ ...step, images: [] }], credits: [] },
      promptOverrides: { generation: '   ' },
    })).toEqual([])
  })

  it('numbers the replies of a multi-step thread', () => {
    const review = initialXPostThreadReview({
      steps: [
        { id: 'first', prompt: 'first prompt', model: null, images: [] },
        { id: 'second', prompt: 'second prompt', model: { label: 'Veo 3.1', provider: null }, images: [image(0)] },
      ],
      credits: [],
    })
    expect(buildXPostThreadReplies(review)).toEqual([
      {
        id: 'step:first',
        stepId: 'first',
        text: 'Prompt (1/2):\nfirst prompt',
        imageAssetIds: [],
        images: [],
      },
      {
        id: 'step:second',
        stepId: 'second',
        text: 'Made with Veo 3.1 (2/2). Prompt:\nsecond prompt',
        imageAssetIds: ['image-0'],
        images: [image(0)],
      },
    ])
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

  it('keeps only YouTube and X originals and derives mentions from status URLs', () => {
    const youtube = xPostSourceCredit('yt', {
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
      uploader: 'Original Filmmaker',
    })
    const xStatus = xPostSourceCredit('x', {
      source_url: 'https://twitter.com/source_owner/status/12345?ref=test',
      uploader: 'Source Owner',
    })
    const xProfile = xPostSourceCredit('profile', {
      source_url: 'https://x.com/unverified_name',
      uploader: '@unverified_name',
    })
    const unsupported = xPostSourceCredit('site', {
      source_url: 'https://example.com/video',
    })

    expect(youtube).toMatchObject({ label: 'Original Filmmaker', xHandle: null })
    expect(xStatus).toMatchObject({
      url: 'https://x.com/source_owner/status/12345',
      xHandle: 'source_owner',
    })
    expect(xProfile).toMatchObject({ label: 'unverified_name', xHandle: null })
    expect(unsupported).toBeNull()
    expect(dedupeXPostSourceCredits([
      youtube!,
      { ...youtube!, id: 'duplicate' },
      xStatus!,
    ])).toEqual([youtube, xStatus])
  })

  it('credits the concrete YouTube video rather than its playlist page', () => {
    expect(xPostSourceCredit('yt', {
      webpage_url: 'https://www.youtube.com/playlist?list=PLWxZwASNHB04',
      source_url: 'https://youtu.be/iZlOQMYjdPg?list=PLWxZwASNHB04',
      uploader: 'Stephanie Morris',
    })).toEqual({
      id: 'yt:https://youtu.be/iZlOQMYjdPg',
      label: 'Stephanie Morris',
      url: 'https://youtu.be/iZlOQMYjdPg',
      xHandle: null,
    })
    expect(xPostSourceCredit('shorts', {
      webpage_url: 'https://www.youtube.com/shorts/abcDEF123?feature=share',
    })?.url).toBe('https://www.youtube.com/shorts/abcDEF123')
    expect(xPostSourceCredit('playlist', {
      webpage_url: 'https://www.youtube.com/playlist?list=PL1#top',
    })).toMatchObject({
      label: 'YouTube',
      url: 'https://www.youtube.com/playlist?list=PL1',
    })
  })

  it('thanks the original video in one editable reply after the prompt', () => {
    const xCredit = {
      id: 'x',
      label: 'Source',
      url: 'https://x.com/source/status/123',
      xHandle: 'source',
    }
    const youtubeCredit = {
      id: 'yt',
      label: 'Original Channel',
      url: 'https://youtu.be/abc',
      xHandle: null,
    }
    const review = initialXPostThreadReview({
      steps: [{ id: 'generation', prompt: 'exact prompt', model: null, images: [] }],
      credits: [youtubeCredit, xCredit],
    })
    expect(xPostThreadHasDetails({ steps: [], credits: [xCredit] })).toBe(true)
    expect(buildXPostThreadReplies(review).map((reply) => [reply.stepId, reply.text])).toEqual([
      ['generation', 'Prompt:\nexact prompt'],
      [null, 'Special thanks to:\n@source: https://x.com/source/status/123\nOriginal Channel: https://youtu.be/abc'],
    ])
    expect(buildXPostThreadReplies({
      ...review,
      context: { ...review.context, credits: [xCredit] },
    }).at(-1)?.text).toBe('Special thanks to @source: https://x.com/source/status/123')
    expect(buildXPostThreadReplies({
      ...review,
      context: { ...review.context, credits: [youtubeCredit] },
    }).at(-1)?.text).toBe('Special thanks to Original Channel: https://youtu.be/abc')
    expect(buildXPostThreadReplies({
      ...review,
      creditsOverride: 'Moves borrowed from @source',
    }).at(-1)).toMatchObject({
      id: 'credits',
      text: 'Moves borrowed from @source',
      imageAssetIds: [],
    })
    expect(buildXPostThreadReplies({ ...review, creditsOverride: '  ' })).toHaveLength(1)
  })

  it('trims a long prompt at a word boundary so the reply fits one post', () => {
    const capacity = 280 - 'Prompt:\n'.length
    const step = {
      id: 'generation',
      prompt: `${'x'.repeat(200)} ${'y'.repeat(100)}`,
      model: null,
      images: [],
    }
    const review = initialXPostThreadReview({ steps: [step], credits: [] })
    expect(xPostThreadPrompt(review, step)).toBe(`${'x'.repeat(200)}…`)
    expect(buildXPostThreadReplies(review)[0]?.text).toBe(`Prompt:\n${'x'.repeat(200)}…`)

    // Without a usable break the cut is hard, leaving room for X to weigh the ellipsis twice.
    const solid = { ...step, id: 'solid', prompt: 'z'.repeat(300) }
    const solidReview = initialXPostThreadReview({ steps: [solid], credits: [] })
    expect(xPostThreadPrompt(solidReview, solid)).toBe(`${'z'.repeat(capacity - 2)}…`)

    const short = { ...step, id: 'short', prompt: '  short prompt  ' }
    const shortReview = initialXPostThreadReview({ steps: [short], credits: [] })
    expect(xPostThreadPrompt(shortReview, short)).toBe('short prompt')

    // An edited prompt posts as typed so the draft validation can flag an overrun.
    expect(buildXPostThreadReplies({
      ...solidReview,
      promptOverrides: { solid: 'a'.repeat(300) },
    })[0]?.text).toHaveLength(308)
  })
})

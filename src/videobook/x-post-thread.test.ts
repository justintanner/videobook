import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  buildXPostThreadReplies,
  discoverXPostThreadGraph,
  initialXPostThreadReview,
  readableXPostPrompt,
  selectXPostGenerationModel,
  selectXPostGenerationPrompt,
  xPostThreadHasDetails,
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

  it('posts the model and prompt first and batches the input images behind them', () => {
    const prompt = Array.from({ length: 90 }, (_, index) => `word-${index}`).join(' ')
    const step = {
      id: 'generation',
      prompt,
      model: { label: 'Seedance 2.5', provider: 'Kie' },
      images: Array.from({ length: 5 }, (_, index) => image(index)),
    }
    const context = { steps: [step] }
    expect(xPostThreadHasDetails(context)).toBe(true)
    expect(xPostThreadHasDetails({ steps: [{ ...step, prompt: ' ', images: [] }] })).toBe(false)
    const disabled = initialXPostThreadReview(context)
    expect(buildXPostThreadReplies(disabled)).toEqual([])

    const enabled = { ...disabled, options: { enabled: true } }
    const replies = buildXPostThreadReplies(enabled)
    expect(replies.length).toBeGreaterThan(2)
    expect(replies[0]?.text.startsWith(
      'How I made this video — Seedance 2.5 via Kie. Prompt:\nword-0 ',
    )).toBe(true)
    expect(replies.every((reply) => reply.text.length <= 280)).toBe(true)
    expect(replies.every((reply) => reply.stepId === 'generation')).toBe(true)
    expect(replies.every((reply) => reply.imageAssetIds.length <= 4)).toBe(true)
    expect(replies[0]?.imageAssetIds).toEqual(['image-0', 'image-1', 'image-2', 'image-3'])
    expect(replies.at(-1)).toMatchObject({
      text: 'Source images used for this video:',
      imageAssetIds: ['image-4'],
    })

    const edited = { ...enabled, promptOverrides: { generation: 'Edited exact prompt' } }
    expect(buildXPostThreadReplies(edited).map((reply) => reply.text)).toEqual([
      'How I made this video — Seedance 2.5 via Kie. Prompt:\nEdited exact prompt',
      'Source images used for this video:',
    ])
    expect(buildXPostThreadReplies({
      ...enabled,
      context: { steps: [{ ...step, images: [] }] },
      promptOverrides: { generation: '   ' },
    })).toEqual([])
  })

  it('numbers the replies of a multi-step thread', () => {
    const review = initialXPostThreadReview({
      steps: [
        { id: 'first', prompt: 'first prompt', model: null, images: [] },
        { id: 'second', prompt: 'second prompt', model: { label: 'Veo 3.1', provider: null }, images: [image(0)] },
      ],
    })
    expect(buildXPostThreadReplies({ ...review, options: { enabled: true } })).toEqual([
      {
        id: 'step:first:prompt:0',
        stepId: 'first',
        text: 'How I made this video (1/2) — prompt:\nfirst prompt',
        imageAssetIds: [],
        images: [],
      },
      {
        id: 'step:second:prompt:0',
        stepId: 'second',
        text: 'How I made this video (2/2) — Veo 3.1. Prompt:\nsecond prompt',
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

  it('never lets a prompt chunk exceed the limit when the cut lands on a space', () => {
    const prefix = 'How I made this video — prompt:\n'
    const capacity = 280 - prefix.length
    const prompt = `${'x'.repeat(capacity)} ${'y'.repeat(40)}`
    const review = initialXPostThreadReview({
      steps: [{ id: 'generation', prompt, model: null, images: [] }],
    })
    const replies = buildXPostThreadReplies({ ...review, options: { enabled: true } })
    expect(replies.map((reply) => reply.text.length)).toEqual([280, 63])
    expect(replies[1]?.text).toBe(`Prompt continued (2):\n ${'y'.repeat(40)}`)
  })
})

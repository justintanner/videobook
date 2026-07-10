import { describe, expect, it } from 'vitest'
import {
  appendRunAsset,
  createEmptyDefinition,
  latestAssetId,
  nearestPromptAbove,
  stepRunStatus,
  toolboxStepSeeds,
} from './model'
import type { NotebookPlanDefinition } from './types'

const definition: NotebookPlanDefinition = {
  properties: {},
  sequence: [
    {
      id: 'prompt-1',
      componentType: 'task',
      type: 'prompt',
      name: 'Idea',
      properties: { text: 'A fox walks through rain.' },
    },
    {
      id: 'image-1',
      componentType: 'task',
      type: 'image',
      name: 'Frame',
      properties: { asset_ids: ['img-first', 'img-second'] },
    },
    {
      id: 'video-1',
      componentType: 'task',
      type: 'video',
      name: 'Motion',
      properties: { values: { prompt: 'Move forward.' } },
    },
  ],
}

describe('notebook model', () => {
  it('creates an empty definition and the three toolbox cell seeds', () => {
    expect(createEmptyDefinition()).toEqual({ properties: {}, sequence: [] })
    expect(toolboxStepSeeds.map((step) => step.type)).toEqual(['prompt', 'image', 'video'])
    expect(toolboxStepSeeds.every((step) => step.componentType === 'task')).toBe(true)
  })

  it('finds the nearest prompt above a generation step', () => {
    expect(nearestPromptAbove(definition, 1)?.id).toBe('prompt-1')
    expect(nearestPromptAbove(definition, 2)?.id).toBe('prompt-1')
    expect(nearestPromptAbove(definition, 0)).toBeNull()
  })

  it('reads the latest run and appends a new immutable run asset', () => {
    expect(latestAssetId(definition.sequence[1])).toBe('img-second')
    expect(latestAssetId(definition.sequence[2])).toBeNull()

    const updated = appendRunAsset(definition, 'image-1', 'img-third')
    expect(updated.sequence[1].properties.asset_ids).toEqual(['img-first', 'img-second', 'img-third'])
    expect(definition.sequence[1].properties.asset_ids).toEqual(['img-first', 'img-second'])

    const ran = appendRunAsset(definition, 'image-1', 'img-third', { model: 'nano_banana', provider: 'kie' })
    expect(ran.sequence[1].properties.model).toBe('nano_banana')
    expect(ran.sequence[1].properties.provider).toBe('kie')
  })

  it('derives a run state from the latest output asset', () => {
    const image = definition.sequence[1]
    expect(stepRunStatus(image, [])).toEqual({ state: 'missing', assetId: 'img-second' })
    expect(stepRunStatus(image, [{ id: 'img-second', status: 'ready' }])).toEqual({
      state: 'ready',
      assetId: 'img-second',
    })
    expect(stepRunStatus(image, [{ id: 'img-second', status: 'generating' }])).toEqual({
      state: 'pending',
      assetId: 'img-second',
    })
    expect(stepRunStatus(image, [{ id: 'img-second', status: 'error', failedMessage: 'No credits' }])).toEqual({
      state: 'error',
      assetId: 'img-second',
      message: 'No credits',
    })
  })
})

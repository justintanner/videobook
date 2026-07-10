import { describe, expect, it } from 'vitest'
import type { ModelOption } from '@/components/gen/types'
import {
  addAssetStep,
  addStep,
  appendRunAsset,
  assetSlugKind,
  canConnect,
  connectSteps,
  createEmptyDefinition,
  disconnectSteps,
  graphLayoutBounds,
  latestAssetId,
  moveSteps,
  normalizeDefinition,
  removeSteps,
  resolveEffectiveValues,
  setFirstFrameSource,
  stepInputReadiness,
  stepInvalidReason,
  stepInputs,
  stepPosition,
  stepRunStatus,
  toolboxStepSeeds,
  wouldCreateCycle,
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
      properties: { text: 'A fox walks through rain.', position: { x: 10, y: 20 } },
    },
    {
      id: 'image-1',
      componentType: 'task',
      type: 'image',
      name: 'Frame',
      properties: { asset_ids: ['img-first', 'img-second'], position: { x: 10, y: 180 } },
    },
    {
      id: 'video-1',
      componentType: 'task',
      type: 'video',
      name: 'Motion',
      properties: { values: { prompt: 'Move forward.' }, position: { x: 10, y: 440 } },
    },
  ],
}

const NOTEBOOK_E2E_DEFINITION: NotebookPlanDefinition = {
  properties: {},
  sequence: [
    {
      id: 'bf973996296897c56872d7bca3db81ad',
      componentType: 'task',
      type: 'prompt',
      name: 'Prompt',
      properties: { text: 'helllo!' },
    },
    {
      id: '2006915435b18fed7f0b149a92f99d4f',
      componentType: 'task',
      type: 'image',
      name: 'Image',
      properties: {
        model: 'nano_banana',
        provider: 'google',
        values: { prompt: 'helllo!' },
        asset_ids: [],
      },
    },
  ],
}

const imageOption: ModelOption = {
  key: 'model',
  label: 'Model',
  tool_name: 'generate_image',
  description: '',
  prefilled_values: {},
  validation: { valid: true, missing_required: [], warnings: [] },
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      image_slugs: { type: 'array', maxItems: 2 },
      first_frame_slug: { type: 'string' },
      video_slug: { type: 'string' },
    },
  },
}

describe('notebook model', () => {
  it('creates an empty definition and the three toolbox cell seeds', () => {
    expect(createEmptyDefinition()).toEqual({ properties: {}, sequence: [] })
    expect(toolboxStepSeeds.map((step) => step.type)).toEqual(['prompt', 'image', 'video'])
    expect(toolboxStepSeeds.every((step) => step.componentType === 'task')).toBe(true)
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

  it('normalizes positions and converts legacy references to edges and asset nodes', () => {
    const legacy: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'source', componentType: 'task', type: 'image', name: 'Source',
          properties: { asset_ids: ['img-output'] },
        },
        {
          id: 'target', componentType: 'task', type: 'video', name: 'Target',
          properties: {
            values: {
              prompt: 'Animate it',
              image_slugs: ['@img-output', '@img-external'],
              first_frame_slug: '@img-external',
            },
          },
        },
      ],
    }
    const migrated = normalizeDefinition(legacy)
    const target = migrated.definition.sequence.find((step) => step.id === 'target')
    const asset = migrated.definition.sequence.find((step) => step.id === 'asset-img-external')
    expect(migrated.changed).toBe(true)
    expect(target && stepInputs(target)).toEqual(['source', 'asset-img-external'])
    expect(target?.properties.first_frame_source).toBe('asset-img-external')
    expect(target?.properties.values).toEqual({ prompt: 'Animate it' })
    expect(asset?.properties.slug).toBe('@img-external')
    expect(migrated.definition.sequence.every((step) => {
      const position = stepPosition(step)
      return position !== null && Number.isInteger(position.x) && Number.isInteger(position.y)
    })).toBe(true)
    const idempotent = normalizeDefinition(migrated.definition)
    expect(idempotent.changed).toBe(false)
    expect(idempotent.definition).toBe(migrated.definition)
  })

  it('migrates the notebook-e2e plan fixture without changing its content semantics', () => {
    const migrated = normalizeDefinition(NOTEBOOK_E2E_DEFINITION)
    expect(migrated.changed).toBe(true)
    expect(migrated.definition.sequence.map((step) => step.id)).toEqual(
      NOTEBOOK_E2E_DEFINITION.sequence.map((step) => step.id),
    )
    expect(migrated.definition.sequence[0].properties.text).toBe('helllo!')
    expect(migrated.definition.sequence[1].properties.values).toEqual({ prompt: 'helllo!' })
    expect(migrated.definition.sequence.every((step) => stepPosition(step) !== null)).toBe(true)
    const repeat = normalizeDefinition(migrated.definition)
    expect(repeat.changed).toBe(false)
    expect(repeat.definition).toBe(migrated.definition)
  })

  it('connects, prevents cycles, disconnects, pins, and removes inputs', () => {
    const connected = connectSteps(definition, 'prompt-1', 'image-1')
    const chained = connectSteps(connected, 'image-1', 'video-1')
    expect(canConnect(chained, 'video-1', 'image-1')).toBe(false)
    expect(wouldCreateCycle(chained, 'video-1', 'image-1')).toBe(true)
    expect(stepInputs(chained.sequence[1])).toEqual(['prompt-1'])
    expect(stepInputs(chained.sequence[2])).toEqual(['image-1'])
    const pinned = setFirstFrameSource(chained, 'video-1', 'image-1')
    expect(pinned.sequence[2].properties.first_frame_source).toBe('image-1')
    const disconnected = disconnectSteps(pinned, 'image-1', 'video-1')
    expect(stepInputs(disconnected.sequence[2])).toEqual([])
    expect(disconnected.sequence[2].properties.first_frame_source).toBeUndefined()
    const pruned = removeSteps(chained, ['image-1'])
    expect(pruned.sequence.map((step) => step.id)).toEqual(['prompt-1', 'video-1'])
    expect(stepInputs(pruned.sequence[1])).toEqual([])
  })

  it('adds and moves stable graph nodes and reuses assets by slug', () => {
    const added = addStep(createEmptyDefinition(), toolboxStepSeeds[0], { x: 1.2, y: 2.8 })
    expect(added.sequence).toHaveLength(1)
    const moved = moveSteps(added, [{ id: added.sequence[0].id, position: { x: 5.6, y: 9.4 } }])
    expect(stepPosition(moved.sequence[0])).toEqual({ x: 6, y: 9 })
    const asset = addAssetStep(moved, 'img-fox', { x: 100, y: 200 })
    const reused = addAssetStep(asset.definition, '@img-fox', { x: 0, y: 0 })
    expect(reused.definition).toBe(asset.definition)
    expect(reused.stepId).toBe(asset.stepId)
    expect(graphLayoutBounds(asset.definition).maxY).toBeGreaterThan(200)
    expect(assetSlugKind('@img-fox')).toBe('image')
    expect(assetSlugKind('vid-clip')).toBe('video')
    expect(assetSlugKind('aud-bed')).toBe('audio')
    expect(assetSlugKind('char-ref')).toBe('character')
  })

  it('resolves input-owned values and reports readiness and validity', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Prompt',
          properties: { text: 'Linked prompt' },
        },
        {
          id: 'asset', componentType: 'task', type: 'asset', name: 'Asset',
          properties: { slug: '@img-source' },
        },
        {
          id: 'target', componentType: 'task', type: 'image', name: 'Target',
          properties: { values: { prompt: 'Ignored local prompt' }, inputs: ['prompt', 'asset'], first_frame_source: 'asset' },
        },
      ],
    }
    const target = graph.sequence[2]
    const resolved = resolveEffectiveValues(graph, target, imageOption)
    expect(resolved.values).toEqual({ prompt: 'Linked prompt', first_frame_slug: '@img-source' })
    expect(resolved.promptFromInputs).toBe('Linked prompt')
    expect(stepInputReadiness(graph, target, [{ id: 'img-source', status: 'ready' }])).toEqual({ ready: true, reasons: [] })
    expect(stepInputReadiness(graph, target, [])).toEqual({ ready: false, reasons: ['Asset is not ready.'] })
    expect(stepInvalidReason(graph, target)).toBeNull()
    expect(stepInvalidReason(graph, { ...target, properties: { ...target.properties, values: {} } })).toBeNull()
  })
})

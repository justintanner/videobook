import { describe, expect, it } from 'vitest'
import { filterValuesForMode, getMode } from '@/components/gen/modes'
import type { ModelOption } from '@/components/gen/types'
import {
  NOTEBOOK_TRACK_ORIGIN_Y,
  NOTEBOOK_TRACK_ROW_PITCH,
  addAssetStep,
  addStep,
  appendRunAsset,
  assetSlugKind,
  autoLayout,
  canConnect,
  connectSteps,
  connectedMediaInputs,
  createEmptyDefinition,
  disconnectSteps,
  graphLayoutBounds,
  latestAssetId,
  moveSteps,
  notebookNodeSizes,
  notebookDropTarget,
  notebookTrackDepths,
  notebookTrackLayout,
  normalizeDefinition,
  reorderStepsOnTracks,
  removeSteps,
  resolveEffectiveValues,
  setFirstFrameSource,
  snapDefinitionToTracks,
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

const omniOption: ModelOption = {
  ...imageOption,
  key: 'gemini_omni',
  label: 'Gemini Omni Video',
  tool_name: 'generate_google_omni_video',
  modes: {
    shared_params: ['prompt', 'duration', 'aspect_ratio'],
    default_mode: 't2v',
    modes: [
      { key: 't2v', label: 'Text', params: [] },
      {
        key: 'i2v',
        label: 'First frame',
        params: ['first_frame_slug'],
        required: ['first_frame_slug'],
        asset_slots: [{ param: 'first_frame_slug', kind: 'image', label: 'First frame' }],
      },
      {
        key: 'r2v',
        label: 'References',
        params: ['image_slugs'],
        asset_slots: [{ param: 'image_slugs', kind: 'image', label: 'References', max: 7 }],
      },
    ],
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

  it('auto-layouts a connected graph top-to-bottom without overlapping rows', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Prompt',
          properties: { text: 'hi', position: { x: 900, y: 40 } },
        },
        {
          id: 'asset', componentType: 'task', type: 'asset', name: 'Asset',
          properties: { slug: '@img-source', position: { x: 10, y: 10 } },
        },
        {
          id: 'target', componentType: 'task', type: 'image', name: 'Target',
          properties: { inputs: ['prompt', 'asset'], position: { x: 40, y: 40 } },
        },
      ],
    }
    const laid = autoLayout(graph)
    const promptPos = stepPosition(laid.sequence[0])!
    const assetPos = stepPosition(laid.sequence[1])!
    const targetPos = stepPosition(laid.sequence[2])!
    expect(promptPos.y).toBe(assetPos.y)
    expect(targetPos.y).toBeGreaterThan(promptPos.y)
    expect(new Set([promptPos.x, assetPos.x]).size).toBe(2)
    expect(autoLayout(createEmptyDefinition())).toEqual(createEmptyDefinition())
  })

  it('converts freeform positions to dependency tracks while preserving horizontal order', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'right', componentType: 'task', type: 'prompt', name: 'Right',
          properties: { text: 'right', position: { x: 800, y: 12 } },
        },
        {
          id: 'left', componentType: 'task', type: 'asset', name: 'Left',
          properties: { slug: '@img-left', position: { x: 100, y: 700 } },
        },
        {
          id: 'child', componentType: 'task', type: 'image', name: 'Child',
          properties: { inputs: ['left'], position: { x: 40, y: 40 } },
        },
      ],
    }
    const migrated = normalizeDefinition(graph)
    const layout = notebookTrackLayout(migrated.definition)
    expect(migrated.changed).toBe(true)
    expect(layout.rows.map((row) => row.stepIds)).toEqual([['left', 'right'], ['child']])
    expect(stepPosition(migrated.definition.sequence[0])?.y).toBe(NOTEBOOK_TRACK_ORIGIN_Y)
    expect(stepPosition(migrated.definition.sequence[2])?.y).toBe(
      NOTEBOOK_TRACK_ORIGIN_Y + NOTEBOOK_TRACK_ROW_PITCH,
    )
    const repeated = normalizeDefinition(migrated.definition)
    expect(repeated.changed).toBe(false)
    expect(repeated.definition).toBe(migrated.definition)
  })

  it('honors requested depths and clears them when dragged back up', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: ['a', 'b', 'c'].map((id, index) => ({
        id,
        componentType: 'task' as const,
        type: 'prompt' as const,
        name: id,
        properties: { text: id, position: { x: index * 300, y: 0 } },
      })),
    }
    const tracked = snapDefinitionToTracks(graph)
    
    // Drag 'c' down
    const movedDown = reorderStepsOnTracks(tracked, [{ id: 'c', position: { x: 300, y: 9999 } }])
    const layoutDown = notebookTrackLayout(movedDown)
    // clamped to last row (depth 0 initially, boardLastRow returns 1 if stage_count is 1 and no steps have depth, wait, it clamps to max depth + 1).
    const cDepth = layoutDown.depths.get('c')
    expect(cDepth).toBeGreaterThan(0)
    expect(movedDown.sequence.find(s => s.id === 'c')?.properties.depth).toEqual(cDepth)

    // Drag 'c' back up to row 0
    const movedUp = reorderStepsOnTracks(movedDown, [{ id: 'c', position: { x: 300, y: 0 } }])
    expect(movedUp.sequence.find(s => s.id === 'c')?.properties.depth).toBeUndefined()
  })

  it('selects a smart parent only from the stage immediately above the drop', () => {
    const graph: NotebookPlanDefinition = snapDefinitionToTracks({
      properties: {},
      sequence: [
        {
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Prompt',
          properties: { text: 'go', position: { x: 0, y: 0 } },
        },
        {
          id: 'asset', componentType: 'task', type: 'asset', name: 'Asset',
          properties: { slug: '@img-ref', position: { x: 300, y: 0 } },
        },
      ],
    })
    const layout = notebookTrackLayout(graph)
    const promptPosition = layout.positions.get('prompt')!
    const selected = notebookDropTarget(graph, 'image', {
      x: promptPosition.x,
      y: NOTEBOOK_TRACK_ORIGIN_Y + NOTEBOOK_TRACK_ROW_PITCH,
    }, 'prompt')
    expect(selected).toMatchObject({ parentId: 'prompt', depth: 1 })

    const assetPosition = layout.positions.get('asset')!
    const nearest = notebookDropTarget(graph, 'video', {
      x: assetPosition.x,
      y: NOTEBOOK_TRACK_ORIGIN_Y + NOTEBOOK_TRACK_ROW_PITCH,
    }, null)
    expect(nearest).toMatchObject({ parentId: 'asset', depth: 1 })

    const promptCenter = promptPosition.x + notebookNodeSizes.prompt.width / 2
    const assetCenter = assetPosition.x + notebookNodeSizes.asset.width / 2
    const ambiguous = notebookDropTarget(graph, 'image', {
      x: (promptCenter + assetCenter) / 2 - notebookNodeSizes.image.width / 2,
      y: NOTEBOOK_TRACK_ORIGIN_Y + NOTEBOOK_TRACK_ROW_PITCH,
    }, null)
    // ambiguous drop now { parentId: null, depth: requested }; prompt deep-drop no longer forced to 0.
    expect(ambiguous).toMatchObject({ parentId: null, depth: 1 })
    expect(notebookDropTarget(graph, 'prompt', { x: 800, y: 800 }, 'asset').depth).toBe(1)
    expect(notebookTrackDepths(graph)).toEqual(new Map([['prompt', 0], ['asset', 0]]))
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

  it('routes an unpinned image input through the selected first-frame mode', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'asset', componentType: 'task', type: 'asset', name: 'Asset',
          properties: { slug: '@img-source' },
        },
        {
          id: 'target', componentType: 'task', type: 'video', name: 'Target',
          properties: { mode: 'i2v', values: {}, inputs: ['asset'] },
        },
      ],
    }
    const target = graph.sequence[1]
    const mode = getMode(omniOption.modes!, 'i2v')
    const resolved = resolveEffectiveValues(graph, target, omniOption, mode)
    const payload = filterValuesForMode(omniOption.modes!, mode.key, resolved.values)

    expect(resolved.values).toEqual({ first_frame_slug: '@img-source' })
    expect(payload).toEqual({ first_frame_slug: '@img-source' })
    expect(payload).not.toHaveProperty('image_slugs')
  })

  it('builds ordered connected media inputs excluding prompts with icon-fallback thumbs', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Prompt',
          properties: { text: 'Ignore me' },
        },
        {
          id: 'asset-a', componentType: 'task', type: 'asset', name: 'Asset A',
          properties: { slug: '@img-alpha' },
        },
        {
          id: 'upstream', componentType: 'task', type: 'image', name: 'Upstream',
          properties: { model: 'nano_banana', asset_ids: ['img-up'] },
        },
        {
          id: 'asset-b', componentType: 'task', type: 'asset', name: 'Asset B',
          properties: { slug: '@vid-beta' },
        },
        {
          id: 'target', componentType: 'task', type: 'video', name: 'Target',
          properties: { inputs: ['prompt', 'asset-a', 'upstream', 'asset-b'] },
        },
      ],
    }
    const target = graph.sequence[4]
    const strip = connectedMediaInputs(graph, target, [
      { id: 'img-alpha', thumbnailSrc: '/thumbs/alpha.jpg' },
      { id: 'img-up', thumbnailSrc: null },
    ])
    expect(strip.map((item) => item.sourceId)).toEqual(['asset-a', 'upstream', 'asset-b'])
    expect(strip.find((item) => item.sourceId === 'prompt')).toBeUndefined()
    expect(strip[0]).toMatchObject({
      sourceId: 'asset-a',
      kind: 'image',
      thumbnailSrc: '/thumbs/alpha.jpg',
      label: '@img-alpha',
    })
    expect(strip[1]).toMatchObject({
      sourceId: 'upstream',
      kind: 'image',
      thumbnailSrc: null,
      label: 'nano_banana',
    })
    expect(strip[2]).toMatchObject({
      sourceId: 'asset-b',
      kind: 'video',
      thumbnailSrc: null,
      label: '@vid-beta',
    })
    expect(connectedMediaInputs(graph, graph.sequence[0], [])).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { filterValuesForMode, getMode } from '@/components/gen/modes'
import type { ModelOption } from '@/components/gen/types'
import {
  CONNECTION_OWNED_PARAMS,
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
  sanitizeValuesForOption,
  setInputRoute,
  slugHasRole,
  buildSceneReplaceDefaultPrompt,
  connectedMediaSlugs,
  snapDefinitionToTracks,
  stepInputReadiness,
  stepInvalidReason,
  stepInputs,
  stepPosition,
  stepRunStatus,
  toolboxStepSeeds,
  wouldCreateCycle,
} from './model'
import { isAssetField } from '@/components/gen/ui/fieldHelpers'
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
      type: 'generate_image',
      name: 'Frame',
      properties: { media_type: 'image', asset_ids: ['img-first', 'img-second'], position: { x: 10, y: 180 } },
    },
    {
      id: 'video-1',
      componentType: 'task',
      type: 'generate_video',
      name: 'Motion',
      properties: { media_type: 'video', values: { prompt: 'Move forward.' }, position: { x: 10, y: 440 } },
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
      type: 'generate_image',
      name: 'Image',
      properties: {
        media_type: 'image',
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
  tool_name: 'generate_google_flow_omni_flash_video',
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
  it('CONNECTION_OWNED_PARAMS covers Seedance multi-ref arrays so Options omit violet drop slots', () => {
    expect(CONNECTION_OWNED_PARAMS).toEqual(expect.arrayContaining([
      'image_slugs', 'video_slug', 'video_slugs', 'audio_slugs', 'first_frame_slug', 'last_frame_slug',
    ]))
    for (const param of CONNECTION_OWNED_PARAMS) {
      expect(isAssetField(param), param).toBe(true)
    }
  })

  it('creates an empty definition and the fourteen cell seeds', () => {
    expect(createEmptyDefinition()).toEqual({ properties: {}, sequence: [] })
    expect(toolboxStepSeeds.map((step) => step.type)).toEqual([
      'audio',
      'image',
      'video',
      'extract_audio',
      'split_video',
      'prompt',
      'character',
      'analyze',
      'analysis',
      'generate_video',
      'generate_image',
      'generate_audio',
      'concat',
      'splice',
    ])
    expect(toolboxStepSeeds.map((step) => step.toolboxKind)).toEqual(
      toolboxStepSeeds.map((step) => step.type),
    )
    expect(toolboxStepSeeds.every((step) => step.componentType === 'task')).toBe(true)
  })

  it('rejects unsupported cell types without compatibility migration', () => {
    const legacy = {
      properties: {},
      sequence: [
        { id: 'legacy', componentType: 'task', type: 'asset', name: 'Legacy', properties: {} },
      ],
    } as unknown as NotebookPlanDefinition
    expect(() => normalizeDefinition(legacy)).toThrow('Unsupported notebook cell type: asset')
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

  it('normalizes positions without importing deprecated value references', () => {
    const unpositioned: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'source', componentType: 'task', type: 'generate_image', name: 'Source',
          properties: { media_type: 'image', asset_ids: ['img-output'] },
        },
        {
          id: 'target', componentType: 'task', type: 'generate_video', name: 'Target',
          properties: {
            media_type: 'video',
            values: {
              prompt: 'Animate it',
              image_slugs: ['@img-output', '@img-external'],
              first_frame_slug: '@img-external',
            },
          },
        },
      ],
    }
    const normalized = normalizeDefinition(unpositioned)
    const target = normalized.definition.sequence.find((step) => step.id === 'target')
    expect(normalized.changed).toBe(true)
    expect(normalized.definition.sequence.map((step) => step.id)).toEqual(['source', 'target'])
    expect(target && stepInputs(target)).toEqual([])
    expect(target?.properties.values).toEqual({
      prompt: 'Animate it',
      image_slugs: ['@img-output', '@img-external'],
      first_frame_slug: '@img-external',
    })
    expect(normalized.definition.sequence.every((step) => {
      const position = stepPosition(step)
      return position !== null && Number.isInteger(position.x) && Number.isInteger(position.y)
    })).toBe(true)
    const idempotent = normalizeDefinition(normalized.definition)
    expect(idempotent.changed).toBe(false)
    expect(idempotent.definition).toBe(normalized.definition)
  })

  it('normalizes the native notebook fixture without changing its content semantics', () => {
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
    const pinned = setInputRoute(chained, 'video-1', 'image-1', 'first_frame_slug')
    expect((pinned.sequence[2].properties.input_routes as Record<string, unknown>)['image-1']).toBe('first_frame_slug')
    const disconnected = disconnectSteps(pinned, 'image-1', 'video-1')
    expect(stepInputs(disconnected.sequence[2])).toEqual([])
    expect((disconnected.sequence[2].properties.input_routes as Record<string, unknown> | undefined)?.['image-1']).toBeUndefined()
    const pruned = removeSteps(chained, ['image-1'])
    expect(pruned.sequence.map((step) => step.id)).toEqual(['prompt-1', 'video-1'])
    expect(stepInputs(pruned.sequence[1])).toEqual([])
  })

  it('connects video actions only through their typed media assets', () => {
    const typed: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'source',
          componentType: 'task',
          type: 'video',
          name: 'Source',
          properties: {},
        },
        {
          id: 'extract',
          componentType: 'task',
          type: 'extract_audio',
          name: 'Extract audio',
          properties: { inputs: [] },
        },
        {
          id: 'audio',
          componentType: 'task',
          type: 'audio',
          name: 'Audio',
          properties: {},
        },
        {
          id: 'split',
          componentType: 'task',
          type: 'split_video',
          name: 'Split video',
          properties: { inputs: [] },
        },
        {
          id: 'video',
          componentType: 'task',
          type: 'video',
          name: 'Video',
          properties: {},
        },
      ],
    }

    expect(canConnect(typed, 'source', 'extract')).toBe(true)
    expect(canConnect(typed, 'extract', 'audio')).toBe(true)
    expect(canConnect(typed, 'source', 'split')).toBe(true)
    expect(canConnect(typed, 'split', 'video')).toBe(true)
    expect(canConnect(typed, 'split', 'extract')).toBe(false)
    expect(canConnect(typed, 'extract', 'video')).toBe(false)
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
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Note',
          properties: { text: 'hi', position: { x: 900, y: 40 } },
        },
        {
          id: 'asset', componentType: 'task', type: 'image', name: 'Source',
          properties: { slug: '@img-source', position: { x: 10, y: 10 } },
        },
        {
          id: 'target', componentType: 'task', type: 'generate_image', name: 'Target',
          properties: { media_type: 'image', inputs: ['prompt', 'asset'], position: { x: 40, y: 40 } },
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
          id: 'left', componentType: 'task', type: 'image', name: 'Left',
          properties: { slug: '@img-left', position: { x: 100, y: 700 } },
        },
        {
          id: 'child', componentType: 'task', type: 'generate_image', name: 'Child',
          properties: { media_type: 'image', inputs: ['left'], position: { x: 40, y: 40 } },
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
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Note',
          properties: { text: 'go', position: { x: 0, y: 0 } },
        },
        {
          id: 'asset', componentType: 'task', type: 'image', name: 'Source',
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
    const assetCenter = assetPosition.x + notebookNodeSizes.image.width / 2
    const ambiguous = notebookDropTarget(graph, 'generate_image', {
      x: (promptCenter + assetCenter) / 2 - notebookNodeSizes.generate_image.width / 2,
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
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Note',
          properties: { text: 'Linked prompt' },
        },
        {
          id: 'asset', componentType: 'task', type: 'image', name: 'Source',
          properties: { slug: '@img-source' },
        },
        {
          id: 'target', componentType: 'task', type: 'generate_image', name: 'Target',
          properties: {
            media_type: 'image',
            values: { prompt: 'Ignored local prompt' },
            inputs: ['prompt', 'asset'],
            input_routes: { asset: 'first_frame_slug' },
          },
        },
      ],
    }
    const target = graph.sequence[2]
    const resolved = resolveEffectiveValues(graph, target, imageOption)
    expect(resolved.values).toEqual({ prompt: 'Linked prompt', first_frame_slug: '@img-source' })
    expect(resolved.promptFromInputs).toBe('Linked prompt')
    expect(stepInputReadiness(graph, target, [{ id: 'img-source', status: 'ready' }])).toEqual({ ready: true, reasons: [] })
    expect(stepInputReadiness(graph, target, [])).toEqual({ ready: false, reasons: ['Source is not ready.'] })
    expect(stepInvalidReason(graph, target)).toBeNull()
    expect(stepInvalidReason(graph, { ...target, properties: { ...target.properties, values: {} } })).toBeNull()
  })

  describe('scene/replace default prompt', () => {
    it('slugHasRole matches hyphen tokens and ignores substrings', () => {
      expect(slugHasRole('@img-scene', 'scene')).toBe(true)
      expect(slugHasRole('img-nbp-scene-reference-1', 'scene')).toBe(true)
      expect(slugHasRole('@img-replace', 'replace')).toBe(true)
      expect(slugHasRole('@img-hero', 'scene')).toBe(false)
      expect(slugHasRole('@img-scenery', 'scene')).toBe(false)
      expect(slugHasRole('@img-replacement-pack', 'replace')).toBe(false)
    })

    it('buildSceneReplaceDefaultPrompt composes scene and replace parts', () => {
      expect(buildSceneReplaceDefaultPrompt(['@img-scene', '@img-replace'])).toBe(
        'scene @img-scene replace actor @img-replace',
      )
      expect(buildSceneReplaceDefaultPrompt(['@img-scene'])).toBe('scene @img-scene')
      expect(buildSceneReplaceDefaultPrompt(['@img-replace'])).toBe('replace actor @img-replace')
      expect(buildSceneReplaceDefaultPrompt(['@img-hero', '@img-bg'])).toBeNull()
      expect(buildSceneReplaceDefaultPrompt([])).toBeNull()
    })

    it('fills an empty GEN IMAGE prompt from scene/replace assets', () => {
      const graph: NotebookPlanDefinition = {
        properties: {},
        sequence: [
          {
            id: 'scene', componentType: 'task', type: 'image', name: 'Scene',
            properties: { slug: '@img-scene' },
          },
          {
            id: 'replace', componentType: 'task', type: 'image', name: 'Replace',
            properties: { slug: '@img-replace' },
          },
          {
            id: 'target', componentType: 'task', type: 'generate_video', name: 'Target',
            properties: { media_type: 'image', values: {}, inputs: ['scene', 'replace'] },
          },
        ],
      }
      const target = graph.sequence[2]
      const resolved = resolveEffectiveValues(graph, target, imageOption)
      expect(resolved.values.prompt).toBe('scene @img-scene replace actor @img-replace')
      expect(resolved.values.image_slugs).toEqual(['@img-scene', '@img-replace'])
      expect(resolved.promptFromInputs).toBeNull()
      expect(connectedMediaSlugs(graph, target)).toEqual(['@img-scene', '@img-replace'])
      expect(stepInvalidReason(graph, target)).toBeNull()
    })

    it('does not overwrite a user prompt or a connected prompt node', () => {
      const withUserPrompt: NotebookPlanDefinition = {
        properties: {},
        sequence: [
          {
            id: 'scene', componentType: 'task', type: 'image', name: 'Scene',
            properties: { slug: '@img-scene' },
          },
          {
            id: 'replace', componentType: 'task', type: 'image', name: 'Replace',
            properties: { slug: '@img-replace' },
          },
          {
            id: 'target', componentType: 'task', type: 'generate_image', name: 'Target',
            properties: {
              media_type: 'image',
              values: { prompt: 'custom swap' },
              inputs: ['scene', 'replace'],
            },
          },
        ],
      }
      const userTarget = withUserPrompt.sequence[2]
      expect(resolveEffectiveValues(withUserPrompt, userTarget, imageOption).values.prompt).toBe('custom swap')

      const withPromptNode: NotebookPlanDefinition = {
        properties: {},
        sequence: [
          {
            id: 'prompt', componentType: 'task', type: 'prompt', name: 'Note',
            properties: { text: 'Linked prompt' },
          },
          {
            id: 'scene', componentType: 'task', type: 'image', name: 'Scene',
            properties: { slug: '@img-scene' },
          },
          {
            id: 'target', componentType: 'task', type: 'generate_image', name: 'Target',
            properties: { media_type: 'image', values: {}, inputs: ['prompt', 'scene'] },
          },
        ],
      }
      const linkedTarget = withPromptNode.sequence[2]
      const linked = resolveEffectiveValues(withPromptNode, linkedTarget, imageOption)
      expect(linked.values.prompt).toBe('Linked prompt')
      expect(linked.promptFromInputs).toBe('Linked prompt')
    })

    it('leaves empty prompts alone when media slugs have no scene/replace roles', () => {
      const graph: NotebookPlanDefinition = {
        properties: {},
        sequence: [
          {
            id: 'asset', componentType: 'task', type: 'image', name: 'Source',
            properties: { slug: '@img-hero' },
          },
          {
            id: 'target', componentType: 'task', type: 'generate_image', name: 'Target',
            properties: { media_type: 'image', values: {}, inputs: ['asset'] },
          },
        ],
      }
      const target = graph.sequence[1]
      const resolved = resolveEffectiveValues(graph, target, imageOption)
      expect(resolved.values.prompt).toBeUndefined()
      expect(stepInvalidReason(graph, target)).toBe('Connect a prompt or write one.')
    })

    it('fills scene/replace default for video steps with mixed media', () => {
      const graph: NotebookPlanDefinition = {
        properties: {},
        sequence: [
          {
            id: 'scene', componentType: 'task', type: 'video', name: 'Scene',
            properties: { slug: '@vid-scene' },
          },
          {
            id: 'replace', componentType: 'task', type: 'image', name: 'Replace',
            properties: { slug: '@img-replace' },
          },
          {
            id: 'target', componentType: 'task', type: 'generate_video', name: 'Target',
            properties: { media_type: 'video', values: {}, inputs: ['scene', 'replace'] },
          },
        ],
      }
      const target = graph.sequence[2]
      const resolved = resolveEffectiveValues(graph, target, imageOption)
      expect(resolved.values.prompt).toBe('scene @vid-scene replace actor @img-replace')
      expect(stepInvalidReason(graph, target)).toBeNull()
    })
  })

  it('routes an unpinned image input through the selected first-frame mode', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'asset', componentType: 'task', type: 'image', name: 'Source',
          properties: { slug: '@img-source' },
        },
        {
          id: 'target', componentType: 'task', type: 'generate_video', name: 'Target',
          properties: { media_type: 'video', mode: 'i2v', values: {}, inputs: ['asset'] },
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

  it('routes Seedance mini media through refs when type is text, and suggests refs mode', () => {
    const seedanceMini: ModelOption = {
      key: 'seedance2_mini',
      label: 'Seedance 2 Mini',
      tool_name: 'generate_seedance2_mini_video',
      description: '',
      prefilled_values: {},
      validation: { valid: true, missing_required: [], warnings: [] },
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          image_slugs: { type: 'array' },
          video_slugs: { type: 'array' },
          audio_slugs: { type: 'array' },
        },
      },
      modes: {
        shared_params: ['prompt'],
        default_mode: 'text',
        modes: [
          { key: 'text', label: 'text', params: [] },
          {
            key: 'refs',
            label: 'refs',
            params: ['image_slugs', 'video_slugs', 'audio_slugs'],
            asset_slots: [
              { param: 'image_slugs', kind: 'image', label: 'Images', min: 0, max: null },
              { param: 'video_slugs', kind: 'video', label: 'Videos', min: 0, max: 3 },
              { param: 'audio_slugs', kind: 'audio', label: 'Audio', min: 0, max: 3 },
            ],
          },
        ],
      },
    }
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'vid', componentType: 'task', type: 'video', name: 'Clip',
          properties: { slug: '@vid-clip' },
        },
        {
          id: 'aud', componentType: 'task', type: 'audio', name: 'Music',
          properties: { slug: '@aud-music' },
        },
        {
          id: 'target', componentType: 'task', type: 'generate_video', name: 'Target',
          properties: { media_type: 'video', mode: 'text', values: {}, inputs: ['vid', 'aud'] },
        },
      ],
    }
    const textMode = getMode(seedanceMini.modes!, 'text')
    const resolved = resolveEffectiveValues(graph, graph.sequence[2], seedanceMini, textMode)
    expect(resolved.warnings).toEqual([])
    expect(resolved.values.video_slugs).toEqual(['@vid-clip'])
    expect(resolved.values.audio_slugs).toEqual(['@aud-music'])
    expect(resolved.suggestedModeKey).toBe('refs')
    const refsMode = getMode(seedanceMini.modes!, 'refs')
    const refsResolved = resolveEffectiveValues(graph, graph.sequence[2], seedanceMini, refsMode)
    expect(refsResolved.suggestedModeKey).toBeNull()
    expect(refsResolved.values.video_slugs).toEqual(['@vid-clip'])
  })

  it('builds ordered connected media inputs excluding prompts with icon-fallback thumbs', () => {
    const graph: NotebookPlanDefinition = {
      properties: {},
      sequence: [
        {
          id: 'prompt', componentType: 'task', type: 'prompt', name: 'Note',
          properties: { text: 'Ignore me' },
        },
        {
          id: 'asset-a', componentType: 'task', type: 'image', name: 'Source A',
          properties: { slug: '@img-alpha' },
        },
        {
          id: 'upstream', componentType: 'task', type: 'generate_image', name: 'Upstream',
          properties: { media_type: 'image', model: 'nano_banana', asset_ids: ['img-up'] },
        },
        {
          id: 'asset-b', componentType: 'task', type: 'video', name: 'Source B',
          properties: { slug: '@vid-beta' },
        },
        {
          id: 'target', componentType: 'task', type: 'generate_video', name: 'Target',
          properties: { media_type: 'video', inputs: ['prompt', 'asset-a', 'upstream', 'asset-b'] },
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

  it('sanitizeValuesForOption filters out values not in option schema or enum', () => {
    const raw = {
      prompt: 'A test prompt',
      duration: '9',
      numeric_duration: 9,
      aspect_ratio: '16:9',
      image_slugs: ['@img-ref'],
      unknown_param: 'should be dropped',
    }
    const option: ModelOption = {
      ...omniOption,
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          duration: { type: 'string', enum: ['4', '6', '8', '10'] },
          numeric_duration: { type: 'number', enum: [4, 6, 8, 10] },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] },
        },
      },
    }
    const sanitized = sanitizeValuesForOption(raw, option)
    expect(sanitized).toEqual({
      prompt: 'A test prompt',
      aspect_ratio: '16:9',
      image_slugs: ['@img-ref'],
    })
  })
})

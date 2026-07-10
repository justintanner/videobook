import type {
  JsonRecord,
  NotebookMediaItem,
  NotebookPlanDefinition,
  NotebookPlanStep,
  NotebookRunStatus,
  NotebookToolboxStep,
} from './types'

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stepAssetIds(step: NotebookPlanStep): string[] {
  return stringArray(step.properties.asset_ids)
}

export function createEmptyDefinition(): NotebookPlanDefinition {
  return { properties: {}, sequence: [] }
}

export const toolboxStepSeeds: NotebookToolboxStep[] = [
  {
    componentType: 'task',
    type: 'prompt',
    name: 'Prompt',
    properties: { text: '' },
  },
  {
    componentType: 'task',
    type: 'image',
    name: 'Image',
    properties: { model: '', provider: '', values: {}, asset_ids: [] },
  },
  {
    componentType: 'task',
    type: 'video',
    name: 'Video',
    properties: { model: '', provider: '', values: {}, asset_ids: [] },
  },
]

export function nearestPromptAbove(
  definition: NotebookPlanDefinition,
  index: number,
): NotebookPlanStep | null {
  for (let current = index - 1; current >= 0; current -= 1) {
    const step = definition.sequence[current]
    if (step.type === 'prompt') return step
  }
  return null
}

export function latestAssetId(step: NotebookPlanStep): string | null {
  const assetIds = stepAssetIds(step)
  return assetIds.at(-1) ?? null
}

export function appendRunAsset(
  definition: NotebookPlanDefinition,
  stepId: string,
  assetId: string,
  ran?: { model: string; provider: string },
): NotebookPlanDefinition {
  return {
    ...definition,
    properties: { ...definition.properties },
    sequence: definition.sequence.map((step) => {
      if (step.id !== stepId) return step
      return {
        ...step,
        properties: {
          ...step.properties,
          // Record the model/provider that actually ran, so the plan stays an
          // accurate record even when the user never touched the default pick.
          ...(ran ? { model: ran.model, provider: ran.provider } : {}),
          asset_ids: [...stepAssetIds(step), assetId],
        } as JsonRecord,
      }
    }),
  }
}

export function stepRunStatus(
  step: NotebookPlanStep,
  mediaItems: NotebookMediaItem[],
): NotebookRunStatus {
  const assetId = latestAssetId(step)
  if (!assetId) return { state: 'idle', assetId: null }
  const asset = mediaItems.find((item) => item.id === assetId)
  // 'missing' (not 'pending'): the recorded output may have been deleted, and a
  // deleted output must not disable Run or pulse the canvas step forever. The
  // brief just-submitted window before sync surfaces the asset also lands here.
  if (!asset) return { state: 'missing', assetId }
  if (asset.status === 'error') {
    return { state: 'error', assetId, message: asset.failedMessage }
  }
  if (asset.status === 'ready') return { state: 'ready', assetId }
  return { state: 'pending', assetId }
}

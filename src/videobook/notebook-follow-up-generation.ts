import type { NotebookDocument, NotebookGridSlot } from 'videobook-engine'
import {
  planNotebookChatGeneration,
  type NotebookChatGenerationDraft,
} from './notebook-chat-generation'
import type { NotebookGenerationAction } from './notebook-generation-actions'
import { nextNotebookCreationSlot, notebookGridTag } from './notebook-grid'

export type NotebookFollowUp = 'extend_video' | 'upscale_video'

export const notebookFollowUps: readonly NotebookFollowUp[] = ['extend_video', 'upscale_video']

export const notebookFollowUpLabels: Record<NotebookFollowUp, string> = {
  extend_video: 'Extend video',
  upscale_video: 'Upscale video',
}

const preferredModels: Record<NotebookFollowUp, readonly string[]> = {
  extend_video: ['fal:minimax/h3-max-turbo/extend-video'],
  upscale_video: ['machgen:Topaz-Video-Precision', 'fal:topaz/upscale/video/precision', 'kie:topaz/video-upscale'],
}

const nativeModels: Partial<Record<NotebookFollowUp, Readonly<Record<string, string>>>> = {
  upscale_video: { 'machgen:MiniMax-H3': 'machgen:MiniMax-H3/upscale' },
}

export function notebookFollowUpModels(
  actions: readonly NotebookGenerationAction[],
  followUp: NotebookFollowUp,
  sourceModel: string | undefined,
): string[] {
  const native = sourceModel ? nativeModels[followUp]?.[sourceModel] : undefined
  const offered = actions
    .filter((action) => action.operation === followUp && action.cellTypes.includes('generate_video'))
    .map((action) => action.model)
  const available = new Map(actions.map((action) => [action.model, action.available !== false]))
  const models = [...new Set([...(native ? [native] : []), ...preferredModels[followUp], ...offered])]
    .filter((model) => available.has(model))
  return [
    ...models.filter((model) => available.get(model)),
    ...models.filter((model) => !available.get(model)),
  ]
}

function planWithModel(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  document: NotebookDocument
  lastWorkSlot: NotebookGridSlot | null
  model: string
  sourceSlot: NotebookGridSlot
}): NotebookChatGenerationDraft | null {
  try {
    const draft = planNotebookChatGeneration({
      actions: input.actions,
      cellId: input.cellId,
      command: {
        cellType: 'generate_video',
        mediaKind: 'video',
        prompt: '',
        sourceReferences: [notebookGridTag(input.sourceSlot)],
      },
      document: input.document,
      fallbackSlot: nextNotebookCreationSlot('generate_video', input.document.cells, input.lastWorkSlot),
      lastWorkSlot: input.lastWorkSlot,
      preferredModel: input.model,
    })
    return draft.action.model === input.model ? draft : null
  } catch {
    return null
  }
}

export function planNotebookFollowUp(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  document: NotebookDocument
  followUp: NotebookFollowUp
  lastWorkSlot: NotebookGridSlot | null
  sourceCellId: string
}): NotebookChatGenerationDraft | null {
  const source = input.document.cells.find((cell) => cell.id === input.sourceCellId)
  if (!source) return null
  for (const model of notebookFollowUpModels(input.actions, input.followUp, source.model)) {
    const draft = planWithModel({ ...input, model, sourceSlot: source.slot })
    if (draft) return draft
  }
  return null
}

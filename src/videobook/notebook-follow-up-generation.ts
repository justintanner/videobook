import type { NotebookCell, NotebookDocument, NotebookGridSlot } from 'videobook-engine'
import { resolveNotebookCellArtifactId } from 'videobook-engine/notebook-media-artifact'
import {
  planNotebookChatGeneration,
  type NotebookChatGenerationDraft,
} from './notebook-chat-generation'
import { parseGenerationRequestInspection } from './generation-request-inspection'
import type { NotebookGenerationAction } from './notebook-generation-actions'
import { notebookGridTag } from './notebook-grid'

export type NotebookFollowUp = 'extend_video' | 'upscale_video'

export const notebookFollowUps: readonly NotebookFollowUp[] = ['extend_video', 'upscale_video']

export const notebookFollowUpLabels: Record<NotebookFollowUp, string> = {
  extend_video: 'Extend video',
  upscale_video: 'Upscale video',
}

const preferredModels: Record<NotebookFollowUp, readonly string[]> = {
  extend_video: ['fal:minimax/h3-max-turbo/extend-video'],
  upscale_video: ['fal:topaz/upscale/video/precision', 'kie:topaz/video-upscale', 'machgen:Topaz-Video-Precision'],
}

const GEMINI_OMNI_EXTEND = 'kie:google/gemini-omni-flash-1-2-extend'

const nativeModels: Partial<Record<NotebookFollowUp, Readonly<Record<string, string>>>> = {
  extend_video: {
    'kie:google/gemini-omni-flash-1-2': GEMINI_OMNI_EXTEND,
    [GEMINI_OMNI_EXTEND]: GEMINI_OMNI_EXTEND,
  },
  upscale_video: { 'machgen:MiniMax-H3': 'machgen:MiniMax-H3/upscale' },
}

const taskSourceOptions: Readonly<Record<string, string>> = {
  [GEMINI_OMNI_EXTEND]: 'task_id',
}

type NotebookToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>

function takesVideo(action: NotebookGenerationAction): boolean {
  return action.inputContract.modes.some((mode) => mode.slots.some((slot) => slot.kind === 'video'))
}

function nativeModel(followUp: NotebookFollowUp, sourceModel: string | undefined): string | undefined {
  if (!sourceModel) return undefined
  return nativeModels[followUp]?.[sourceModel]
    ?? (followUp === 'upscale_video' && sourceModel.startsWith('machgen:') ? 'machgen:Topaz-Video-Precision' : undefined)
}

export function notebookFollowUpModels(
  actions: readonly NotebookGenerationAction[],
  followUp: NotebookFollowUp,
  sourceModel: string | undefined,
): string[] {
  const native = nativeModel(followUp, sourceModel)
  const offered = actions
    .filter((action) => action.operation === followUp && action.cellTypes.includes('generate_video'))
    .map((action) => action.model)
  const available = new Map(actions
    .filter((action) => takesVideo(action) || action.model === native)
    .map((action) => [action.model, action.available !== false]))
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
      preferredModel: input.model,
    })
    return draft.action.model === input.model ? draft : null
  } catch {
    return null
  }
}

function planWithSourceTask(input: {
  actions: readonly NotebookGenerationAction[]
  cellId: string
  document: NotebookDocument
  model: string
  option: string
  sourceTaskId: string | undefined
}): NotebookChatGenerationDraft | null {
  try {
    const draft = planNotebookChatGeneration({
      actions: input.actions,
      cellId: input.cellId,
      command: { cellType: 'generate_video', mediaKind: 'video', prompt: '', sourceReferences: [] },
      document: input.document,
      preferredModel: input.model,
      ...(input.sourceTaskId ? { routedParams: { [input.option]: input.sourceTaskId } } : {}),
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
  sourceCellId: string
  sourceTaskId?: string | null
}): NotebookChatGenerationDraft | null {
  const source = input.document.cells.find((cell) => cell.id === input.sourceCellId)
  if (!source) return null
  for (const model of notebookFollowUpModels(input.actions, input.followUp, source.model)) {
    const option = taskSourceOptions[model]
    if (option && input.sourceTaskId === null) continue
    const draft = option
      ? planWithSourceTask({
        actions: input.actions,
        cellId: input.cellId,
        document: input.document,
        model,
        option,
        sourceTaskId: input.sourceTaskId ?? undefined,
      })
      : planWithModel({
        actions: input.actions,
        cellId: input.cellId,
        document: input.document,
        model,
        sourceSlot: source.slot,
      })
    if (draft) return draft
  }
  return null
}

function sourceTaskModel(followUp: NotebookFollowUp, source: NotebookCell): boolean {
  const native = nativeModel(followUp, source.model)
  return native !== undefined && taskSourceOptions[native] !== undefined
}

export async function readNotebookFollowUpSourceTask(input: {
  bookId: string
  callTool: NotebookToolCall
  document: NotebookDocument
  followUp: NotebookFollowUp
  sourceCellId: string
}): Promise<string | null | undefined> {
  const source = input.document.cells.find((cell) => cell.id === input.sourceCellId)
  if (!source || !sourceTaskModel(input.followUp, source)) return undefined
  const artifactId = resolveNotebookCellArtifactId(input.document, source)
  if (!artifactId) return null
  const inspection = parseGenerationRequestInspection(await input.callTool('inspect_generation_request', {
    book_id: input.bookId,
    asset_id: artifactId,
  }))
  const task = inspection.providerTask
  return task?.provider === 'kie' && task.taskId ? task.taskId : null
}

import type { Node } from '@xyflow/react'
import { AssetNode } from './AssetNode'
import { GenNode } from './GenNode'
import { PromptNode } from './PromptNode'
import { notebookNodeSizes, type ConnectedMediaInput } from '../model'
import type { NotebookPlanStep, NotebookRunState } from '../types'

export interface NotebookNodeData extends Record<string, unknown> {
  step: NotebookPlanStep
  thumbnailSrc: string | null
  cost: string | null
  runState: NotebookRunState
  running: boolean
  error: string | null
  invalidReason: string | null
  missing: boolean
  mediaInputs: ConnectedMediaInput[]
  routeState: 'selected' | 'upstream' | 'downstream' | null
}

export type NotebookFlowNode = Node<NotebookNodeData, NotebookPlanStep['type']>

export const NODE_TYPES = {
  prompt: PromptNode,
  image: GenNode,
  video: GenNode,
  asset: AssetNode,
}

export const NODE_DIMENSIONS = notebookNodeSizes

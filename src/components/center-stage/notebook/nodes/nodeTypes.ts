import type { Node } from '@xyflow/react'
import { AssetNode } from './AssetNode'
import { GenNode } from './GenNode'
import { PrimitiveNode } from './PrimitiveNode'
import { PromptNode } from './PromptNode'
import { notebookNodeSizes, type ConnectedMediaInput, type GenRunOutput } from '../model'
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
  outputs: GenRunOutput[]
  routeState: 'selected' | 'upstream' | 'downstream' | null
  onPromoteAsset?: (stepId: string, assetId: string) => void
}

export type NotebookFlowNode = Node<NotebookNodeData, NotebookPlanStep['type']>

export const NODE_TYPES = {
  source: AssetNode,
  note: PromptNode,
  selects: PrimitiveNode,
  scene: PrimitiveNode,
  asset: GenNode,
}

export const NODE_DIMENSIONS = notebookNodeSizes

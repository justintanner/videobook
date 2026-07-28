import type { MediaItem } from '@/components/sidebar/types'
import type { NotebookCellType } from 'videobook-engine'

export const NOTEBOOK_SCHEMA_VERSION = 13

export type NotebookStepType = NotebookCellType
export type NotebookToolboxKind = NotebookCellType
export type NotebookMediaCellType = Extract<NotebookCellType, 'audio' | 'image' | 'video' | 'character'>

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonRecord
  | JsonValue[]

export interface JsonRecord {
  [key: string]: JsonValue
}

export interface NotebookPlanStep {
  id: string
  componentType: 'task'
  type: NotebookStepType
  name: string
  properties: JsonRecord
}

export interface NotebookPlanDefinition {
  properties: JsonRecord
  sequence: NotebookPlanStep[]
}

export interface NotebookPlanResponse {
  exists: boolean
  definition: NotebookPlanDefinition
}

export type NotebookToolboxStep = Omit<NotebookPlanStep, 'id'> & {
  toolboxKind: NotebookToolboxKind
}

export type NotebookRunState = 'idle' | 'missing' | 'pending' | 'ready' | 'error'

export interface NotebookRunStatus {
  state: NotebookRunState
  assetId: string | null
  message?: string
}

export type NotebookMediaItem = Pick<MediaItem, 'id' | 'status' | 'failedMessage' | 'thumbnailSrc'>

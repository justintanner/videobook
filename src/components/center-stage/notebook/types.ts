import type { MediaItem } from '@/components/sidebar/types'

export const NOTEBOOK_SCHEMA_VERSION = 1

export type NotebookStepType = 'prompt' | 'image' | 'video' | 'asset'

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

export interface NotebookPlanSidecar {
  format: 'notebook'
  schema_version: typeof NOTEBOOK_SCHEMA_VERSION
  definition: NotebookPlanDefinition
}

export interface NotebookPlanResponse {
  exists: boolean
  legacy?: boolean
  definition: NotebookPlanDefinition
}

export type NotebookToolboxStep = Omit<NotebookPlanStep, 'id'>

export type NotebookRunState = 'idle' | 'missing' | 'pending' | 'ready' | 'error'

export interface NotebookRunStatus {
  state: NotebookRunState
  assetId: string | null
  message?: string
}

export type NotebookMediaItem = Pick<MediaItem, 'id' | 'status' | 'failedMessage'>

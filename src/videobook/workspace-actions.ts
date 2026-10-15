import type {
  ActionInputSchema,
  WorkspaceAction,
  WorkspaceActionCatalog,
} from '../../server/src/workspace-action-contract'
import type { ServerCommand } from '../lib/command-registry'

export type ActionChoice = { value: string; label: string; detail?: string }

export function workspaceCropPreset(ratio: string, sourceWidth: number | null, sourceHeight: number | null): Record<string, unknown> {
  const sourceRatio = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : 16 / 9
  const [width = 1, height = 1] = ratio.split(':').map(Number)
  const targetRatio = width / height
  const w = Math.min(1, targetRatio / sourceRatio)
  const h = Math.min(1, sourceRatio / targetRatio)
  return { ratio, x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

export function hasWorkspaceActionResultLinks(action: WorkspaceAction): boolean {
  return action.handler.kind === 'tool' && ['list_prompts', 'list_scenes', 'list_characters', 'list_notebooks', 'asset_history', 'list_book_actions', 'search_archive'].includes(action.handler.tool)
}

export type WorkspaceActionContext = {
  bookId: string
  notebookId?: string
  sequenceId?: string
  sequenceRevision?: string
  cellId?: string
  assetId?: string
  assetIds?: readonly string[]
  cellIds?: readonly string[]
  choices: Record<string, readonly ActionChoice[]>
  entities?: Record<string, Record<string, unknown>>
  media?: Record<string, { url: string | null; type: string; width: number | null; height: number | null; objectHash: string | null }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asWorkspaceActionCatalog(value: unknown): WorkspaceActionCatalog {
  const catalog = record(value)
  if (!Array.isArray(catalog?.actions) || !Array.isArray(catalog.tools)) {
    throw new Error('The action catalog could not be loaded. Reconnect and try again.')
  }
  return value as WorkspaceActionCatalog
}

export function workspaceActionCommands(actions: readonly WorkspaceAction[], existing: readonly ServerCommand[]): ServerCommand[] {
  const reserved = new Set(actions.flatMap((action) => [action.command, ...action.aliases]).map((name) => name.toLowerCase()))
  const retained = existing.filter((command) => command.category !== 'project' || !reserved.has(command.command.toLowerCase()))
  const known = new Set(retained.flatMap((command) => [command.command, ...(command.aliases ?? [])]).map((name) => name.toLowerCase()))
  return [...retained, ...actions.filter((action) => !known.has(action.command.toLowerCase())).map((action): ServerCommand => ({
    command: action.command, description: action.description, aliases: action.aliases,
    workspaceActionId: action.id, category: 'action', icon: 'Play', size: 'default', variant: 'default', chevron: 'right',
    params: Object.entries(action.inputSchema.properties ?? {}).filter(([name]) => name !== 'book_id').map(([name, schema]) => ({
      name, description: schema.description ?? actionFieldLabel(name), required: action.inputSchema.required?.includes(name) ?? false,
      type: schema.type === 'number' || schema.type === 'integer' ? 'number' : schema.type === 'boolean' ? 'boolean' : 'string',
    })),
  }))]
}

export function pendingWorkspaceCommands(commands: readonly ServerCommand[], pending: boolean): ServerCommand[] {
  if (!pending) return [...commands]
  return [...commands, ...['apply', 'cancel'].map((name): ServerCommand => ({
    command: `/${name}`, description: name === 'apply' ? 'Apply the reviewed action' : 'Cancel the pending action',
    category: 'action', icon: name === 'apply' ? 'Check' : 'X', size: 'default', variant: 'default', chevron: 'right', params: [],
  }))]
}

export function actionFieldLabel(name: string): string {
  const label = name.replace(/([a-z])([A-Z])/gu, '$1 $2').replaceAll(/[_-]/gu, ' ')
    .replace(/\b(?:artifact|asset) (?:id|ref)\b/gu, 'media')
    .replace(/\bbook id\b/gu, 'project')
    .replace(/\b(notebook|cell|clip|track|entity) id\b/gu, '$1')
    .replace(/\brefs\b/gu, 'references')
    .replace(/\bdb\b/gu, 'dB')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function actionInputVariants(schema: ActionInputSchema): ActionInputSchema[] {
  const variants = schema.oneOf ?? schema.anyOf
  if (!variants) return []
  return variants.flatMap((variant) => {
    const nested = actionInputVariants(variant)
    return nested.length ? nested : [variant]
  })
}

function matchesSchema(schema: ActionInputSchema, value: unknown): boolean {
  if ('const' in schema) return schema.const === value
  if (schema.enum) return schema.enum.includes(value)
  if (schema.type === 'null') return value === null
  if (schema.type === 'array') return Array.isArray(value)
  if (schema.type === 'object') {
    const object = record(value)
    if (!object) return false
    return Object.entries(schema.properties ?? {}).every(([name, field]) =>
      !('const' in field) || field.const === object[name])
  }
  if (schema.type === 'integer') return Number.isInteger(value)
  return !schema.type || typeof value === schema.type
}

export function resolvedActionInputSchema(schema: ActionInputSchema, value: unknown): ActionInputSchema {
  const variants = actionInputVariants(schema)
  if (!variants.length) return schema
  const selected = variants.find((variant) => matchesSchema(variant, value))
    ?? variants.find((variant) => variant.type !== 'null')
    ?? variants[0]!
  const { anyOf: _anyOf, oneOf: _oneOf, ...base } = schema
  return { ...base, ...selected }
}

export function initialActionInput(schema: ActionInputSchema, required = false): unknown {
  if ('const' in schema) return schema.const
  if (schema.default !== undefined) return structuredClone(schema.default)
  if (!required) return undefined
  const resolved = resolvedActionInputSchema(schema, undefined)
  if ('const' in resolved) return resolved.const
  if (resolved.type === 'object') {
    const requiredFields = new Set(resolved.required ?? [])
    return Object.fromEntries(Object.entries(resolved.properties ?? {})
      .map(([name, field]) => [name, initialActionInput(field, requiredFields.has(name))])
      .filter(([, value]) => value !== undefined))
  }
  if (resolved.type === 'array') {
    return Array.from({ length: resolved.minItems ?? 0 }, () => initialActionInput(resolved.items ?? {}, true))
  }
  if (resolved.enum?.length === 1) return resolved.enum[0]
  if (resolved.type === 'boolean') return false
  if (resolved.type === 'null') return null
  return undefined
}

export function initialActionValues(action: WorkspaceAction, context: WorkspaceActionContext): Record<string, unknown> {
  const defaults = record(initialActionInput(action.inputSchema, true)) ?? {}
  const fields = action.inputSchema.properties ?? {}
  const values = { ...defaults, ...action.initialArgs }
  if (fields._provider && action.generation) values._provider = action.generation.provider
  for (const [name, value] of [
    ['book_id', context.bookId], ['notebook_id', context.notebookId],
    ['sequence_id', context.sequenceId], ['cell_id', context.cellId],
    ['base_revision', context.sequenceRevision], ['sequence_revision', context.sequenceRevision],
    ['source_surface', 'ui'], ['actor', 'videobook-user'],
  ] as const) {
    if (value && fields[name]) values[name] = value
  }
  if (action.target.kind === 'asset' && action.target.argument && context.assetId) {
    const kind = context.choices.asset_id?.find((choice) => choice.value === context.assetId)?.detail
    if (!action.target.mediaKinds || action.target.mediaKinds.some((entry) => entry === kind)) {
      values[action.target.argument] = action.target.multiple ? context.assetIds ?? [context.assetId] : context.assetId
    }
  }
  if (action.target.kind === 'cell' && action.target.multiple && action.target.argument && context.cellIds?.length) values[action.target.argument] = context.cellIds
  if (action.target.kind === 'cell' && !action.target.multiple && action.target.argument && context.cellId) values[action.target.argument] = context.cellId
  if (fields.object_hash && context.assetId && context.media?.[context.assetId]?.objectHash) values.object_hash = context.media[context.assetId]!.objectHash
  return values
}

export function actionUnavailableReason(action: WorkspaceAction, context: WorkspaceActionContext): string | null {
  if (action.scope !== 'global' && !context.bookId) return 'Open or create a project first.'
  if (action.scope === 'notebook' && !context.notebookId) return 'Open a notebook first.'
  if (action.scope === 'sequence' && !context.sequenceId) return 'Open a project with a sequence first.'
  return null
}

export function searchWorkspaceActions(actions: readonly WorkspaceAction[], query: string): WorkspaceAction[] {
  const terms = query.trim().toLowerCase().replace(/^\//u, '').split(/\s+/u).filter(Boolean)
  return actions.filter((action) => {
    const text = [action.title, action.command, action.description, action.group, ...action.aliases, ...action.keywords]
      .join(' ').toLowerCase()
    return terms.every((term) => text.includes(term))
  }).sort((left, right) => {
    const exact = (action: WorkspaceAction) => [action.command, ...action.aliases]
      .some((name) => name.replace(/^\//u, '').toLowerCase() === terms.join(' '))
    return Number(exact(right)) - Number(exact(left)) || left.group.localeCompare(right.group) || left.title.localeCompare(right.title)
  })
}

import { frameAspectRatio } from '../../server/src/media/frame-options'
import { isSeedanceEdit } from '../../server/src/media/seedance-edit'
import type { ActionInputSchema, WorkspaceAction } from '../../server/src/workspace-action-contract'
import { VALID_CONFIRMATION, type ConfirmValidation } from './confirm-validation'
import { generationModelChoices } from './generation-frontier'
import {
  actionUnavailableReason,
  initialActionValues,
  workspaceCropPreset,
  type ActionChoice,
  type WorkspaceActionContext,
} from './workspace-actions'

export type WorkspaceActionResult = { message: string; value?: unknown }
export type WorkspaceActionReview = { message: string; cost?: string }
export type WorkspaceActionDraft = Record<string, unknown>
type WorkspaceActionMedia = NonNullable<WorkspaceActionContext['media']>[string]

const HIDDEN_FIELDS = ['book_id', 'actor', 'source_surface']

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined
}

function optionsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function seedWorkspaceActionDraft(
  action: WorkspaceAction,
  context: WorkspaceActionContext,
  initialValues: WorkspaceActionDraft = {},
): WorkspaceActionDraft {
  const seeded = initialActionValues(action, {
    ...context,
    assetId: typeof initialValues.asset_id === 'string' ? initialValues.asset_id : context.assetId,
    cellId: typeof initialValues.cell_id === 'string' ? initialValues.cell_id : context.cellId,
    assetIds: stringList(initialValues.artifact_ids) ?? context.assetIds,
    cellIds: stringList(initialValues.cell_ids) ?? context.cellIds,
  })
  const properties = action.inputSchema.properties ?? {}
  const carried = Object.entries(initialValues)
    .filter(([name]) => name in properties && (name !== '_provider' || !action.generation))
  return { ...seeded, ...Object.fromEntries(carried) }
}

export function workspaceActionFrameAspectRatio(action: WorkspaceAction, draft: WorkspaceActionDraft): string | undefined {
  return action.generation && typeof draft.model === 'string' ? frameAspectRatio(draft.model, draft) : undefined
}

export function workspaceActionSeedanceEdit(draft: WorkspaceActionDraft): boolean {
  return isSeedanceEdit(String(draft.model ?? ''), draft.mode)
}

export function effectiveWorkspaceActionValues(action: WorkspaceAction, draft: WorkspaceActionDraft): WorkspaceActionDraft {
  const options = optionsRecord(draft.options)
  if (workspaceActionSeedanceEdit(draft)) return { ...draft, options: { ...options, aspect_ratio: 'adaptive', duration: -1 } }
  const aspectRatio = workspaceActionFrameAspectRatio(action, draft)
  return aspectRatio ? { ...draft, options: { ...options, aspect_ratio: aspectRatio } } : draft
}

export function workspaceActionCropMedia(
  action: WorkspaceAction,
  context: WorkspaceActionContext,
  draft: WorkspaceActionDraft,
): WorkspaceActionMedia | undefined {
  if (action.handler.kind !== 'tool' || action.handler.tool !== 'crop_asset' || typeof draft.asset_id !== 'string') return undefined
  return context.media?.[draft.asset_id]
}

export function patchWorkspaceActionDraft(
  action: WorkspaceAction,
  context: WorkspaceActionContext,
  draft: WorkspaceActionDraft,
  name: string,
  value: unknown,
): WorkspaceActionDraft {
  const cropMedia = workspaceActionCropMedia(action, context, draft)
  const cropPreset = cropMedia && name === 'ratio' && typeof value === 'string'
    ? workspaceCropPreset(value, cropMedia.width, cropMedia.height)
    : {}
  const objectHash = name === action.target.argument && typeof value === 'string' && action.inputSchema.properties?.object_hash
    ? { object_hash: context.media?.[value]?.objectHash ?? '' }
    : {}
  return { ...draft, [name]: value, ...cropPreset, ...objectHash }
}

export function workspaceActionFields(action: WorkspaceAction): [string, ActionInputSchema][] {
  const hidden = new Set(action.generation ? [...HIDDEN_FIELDS, '_provider'] : HIDDEN_FIELDS)
  return Object.entries(action.inputSchema.properties ?? {}).filter(([name]) => !hidden.has(name))
}

export function workspaceActionChoices(
  action: WorkspaceAction,
  context: WorkspaceActionContext,
  values: WorkspaceActionDraft,
): Record<string, readonly ActionChoice[]> {
  const argument = action.target.argument
  const mediaKinds = action.target.mediaKinds
  const base = argument && mediaKinds
    ? {
        ...context.choices,
        [argument]: (context.choices[argument] ?? context.choices.asset_id ?? [])
          .filter((choice) => mediaKinds.some((kind) => kind === choice.detail)),
      }
    : context.choices
  return action.generation && base.model
    ? { ...base, model: generationModelChoices(base.model, action.generation.mediaType, values) }
    : base
}

export function workspaceActionVariants(actions: readonly WorkspaceAction[], action: WorkspaceAction | null): WorkspaceAction[] {
  const generation = action?.generation
  if (!generation) return []
  return actions.filter((entry) => entry.generation?.operation === generation.operation && entry.generation?.mediaType === generation.mediaType)
}

export function workspaceActionApplyLabel(action: WorkspaceAction, review: WorkspaceActionReview | null): string {
  if (review) return 'Confirm and run'
  return action.confirmation === 'none' ? 'Run action' : 'Review action'
}

export function workspaceActionValidation(input: {
  action: WorkspaceAction | null
  context: WorkspaceActionContext
  loading: boolean
  error: string | null
  ready: boolean
}): ConfirmValidation {
  if (input.loading || (input.action && !input.ready && !input.error)) return { blocking: 'Loading action…', notice: null }
  if (input.error) return { blocking: input.error, notice: null }
  if (!input.action) return { blocking: 'This action is no longer available.', notice: null }
  const unavailable = actionUnavailableReason(input.action, input.context)
  return unavailable ? { blocking: unavailable, notice: null } : VALID_CONFIRMATION
}

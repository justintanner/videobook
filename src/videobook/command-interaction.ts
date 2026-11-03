import type { WorkspaceAction } from '../../server/src/workspace-action-contract'

type DirectArgs = Record<string, unknown>

type DirectTargetResult =
  | { ok: true; args: DirectArgs }
  | { ok: false; message: string }

const CONTEXT_FIELDS = new Set(['book_id', 'notebook_id', 'sequence_id'])

function missingRequired(action: WorkspaceAction, args: DirectArgs): string[] {
  return (action.inputSchema.required ?? [])
    .filter((name) => !CONTEXT_FIELDS.has(name))
    .filter((name) => args[name] === undefined || args[name] === '')
}

export function commandOpensPreviewForm(action: WorkspaceAction | undefined, rest: string): boolean {
  if (!action || action.interaction !== 'preview') return false
  return !rest.trim() && missingRequired(action, {}).length > 0
}

export function commandRunsAsPreview(action: WorkspaceAction | undefined): boolean {
  return action?.interaction === 'preview'
}

function usageHint(action: WorkspaceAction, missing: readonly string[]): string {
  const target = action.target.kind === 'asset' || action.target.kind === 'cell'
    ? 'Select a cell or name one, such as @a1'
    : `Add ${missing.join(', ')}`
  return `${action.command}: ${target}.`
}

export function fillDirectTarget(
  action: WorkspaceAction,
  args: DirectArgs,
  selectedAssetId: string | undefined,
): DirectTargetResult {
  const argument = action.target.argument
  const filled = argument && action.target.kind === 'asset' && selectedAssetId && args[argument] === undefined
    ? { ...args, [argument]: action.target.multiple ? [selectedAssetId] : selectedAssetId }
    : args
  const missing = missingRequired(action, filled)
  if (missing.length === 0) return { ok: true, args: filled }
  return { ok: false, message: usageHint(action, missing) }
}

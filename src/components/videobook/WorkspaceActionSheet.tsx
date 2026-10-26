import { ArrowLeft } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import type { WorkspaceAction } from '../../../server/src/workspace-action-contract'
import { FRAME_ASPECT_DESCRIPTION } from '../../../server/src/media/frame-options'
import { SEEDANCE_EDIT_DESCRIPTION } from '../../../server/src/media/seedance-edit'
import {
  actionFieldLabel,
  hasWorkspaceActionResultLinks,
  type WorkspaceActionContext,
} from '@/videobook/workspace-actions'
import {
  effectiveWorkspaceActionValues,
  workspaceActionApplyLabel,
  workspaceActionChoices,
  workspaceActionCropMedia,
  workspaceActionFields,
  workspaceActionFrameAspectRatio,
  workspaceActionSeedanceEdit,
  workspaceActionValidation,
  type WorkspaceActionDraft,
  type WorkspaceActionResult,
  type WorkspaceActionReview,
} from '@/videobook/workspace-action-draft'
import { WORKSPACE_ACTION_FORM_ID } from '@/videobook/workspace-action-form'
import { ConfirmSheet } from './confirm/ConfirmSheet'
import type { ConfirmSheetEffect } from './confirm/ConfirmSheetHints'
import { WorkspaceActionField } from './WorkspaceActionField'
import { WorkspaceActionResultLinks } from './WorkspaceActionResultLinks'
import { WorkspaceCropPreview } from './WorkspaceCropPreview'
import './workspace-actions.css'

const ENTITY_EDITOR_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    prompt: { type: 'string' },
    data: { type: 'object', description: 'Optional advanced saved-item data', additionalProperties: true },
  },
}

const DEPENDENT_CHOICE_FIELDS = ['commit_hash', 'filename', 'subject_id', 'subject_ids']

type OpenAction = (actionId: string | undefined, values: WorkspaceActionDraft) => void

type WorkspaceActionSheetProps = {
  action: WorkspaceAction | null
  variants: readonly WorkspaceAction[]
  context: WorkspaceActionContext
  draft: WorkspaceActionDraft | null
  review: WorkspaceActionReview | null
  result: WorkspaceActionResult | null
  loading: boolean
  error: string | null
  busy: boolean
  applyFormId: string
  onChange: (name: string, value: unknown) => void
  onPatch: (patch: WorkspaceActionDraft) => void
  onCancelReview: () => void
  onBack: () => void
  onOpenAction: OpenAction
  onCancel: () => void
}

type WorkspaceActionBodyProps = Omit<WorkspaceActionSheetProps, 'action' | 'draft' | 'loading' | 'error' | 'applyFormId' | 'onCancelReview' | 'onCancel'> & {
  action: WorkspaceAction
  draft: WorkspaceActionDraft
}

function workspaceActionEffect(action: WorkspaceAction | null): ConfirmSheetEffect | null {
  if (action?.confirmation === 'generation') return { label: 'May incur provider charges', tone: 'warning' }
  if (action?.confirmation === 'external') return { label: 'Leaves workspace', tone: 'warning' }
  if (action?.confirmation === 'destructive') return { label: 'Changes or removes content', tone: 'warning' }
  return null
}

function ResultValue({ value, name = 'Result' }: { value: unknown; name?: string }) {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    return <ol className="workspace-action-result-list" aria-label={name}>
      {value.map((entry, index) => <li key={index}><ResultValue value={entry} name={`${name} ${index + 1}`} /></li>)}
    </ol>
  }
  if (typeof value === 'object') {
    return <dl className="workspace-action-result-fields">
      {Object.entries(value).map(([key, entry]) => <div key={key}><dt>{actionFieldLabel(key)}</dt><dd><ResultValue value={entry} name={actionFieldLabel(key)} /></dd></div>)}
    </dl>
  }
  return <span>{typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value)}</span>
}

function WorkspaceActionResultSection({ action, result, values, onOpenAction }: {
  action: WorkspaceAction
  result: WorkspaceActionResult
  values: WorkspaceActionDraft
  onOpenAction: OpenAction
}) {
  return <section className="workspace-action-result" aria-label="Action result">
    <p role="status">{result.message}</p>
    {hasWorkspaceActionResultLinks(action)
      ? <WorkspaceActionResultLinks action={action} value={result.value} values={values} onOpen={onOpenAction} />
      : <ResultValue value={result.value} />}
  </section>
}

function WorkspaceActionVariants({ action, variants, values, busy, onOpenAction }: {
  action: WorkspaceAction
  variants: readonly WorkspaceAction[]
  values: WorkspaceActionDraft
  busy: boolean
  onOpenAction: OpenAction
}) {
  if (variants.length < 2) return null
  return <details className="workspace-action-variants"><summary>Advanced provider and model</summary>
    <label>Provider and model<select aria-label="Provider and model" value={action.id} disabled={busy} onChange={(event) => onOpenAction(event.target.value, values)}>
      {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.generation?.provider} · {variant.title}</option>)}
    </select></label>
  </details>
}

function WorkspaceEntityPicker({ context, entityId, busy, onPatch }: {
  context: WorkspaceActionContext
  entityId: string
  busy: boolean
  onPatch: (patch: WorkspaceActionDraft) => void
}) {
  return <label className="workspace-action-field">Saved item<select aria-label="Saved item" required value={entityId} disabled={busy}
    onChange={(event) => onPatch({ entity: structuredClone(context.entities?.[event.target.value]) })}>
    <option value="">Choose a saved item</option>
    {(context.choices.entity_id ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
  </select></label>
}

function WorkspaceActionBody({ action, variants, context, draft, review, result, busy, onChange, onPatch, onBack, onOpenAction }: WorkspaceActionBodyProps) {
  const formRef = useRef<HTMLFormElement>(null)
  const values = effectiveWorkspaceActionValues(action, draft)
  const frameAspectRatio = workspaceActionFrameAspectRatio(action, draft)
  const required = new Set(action.inputSchema.required ?? [])
  const entityEditor = action.handler.kind === 'tool' && action.handler.tool === 'update_entity'
  const entityId = values.entity && typeof values.entity === 'object' && 'id' in values.entity ? String(values.entity.id) : ''
  const cropMedia = workspaceActionCropMedia(action, context, values)
  const choices = workspaceActionChoices(action, context, values)
  const hasDependentChoices = DEPENDENT_CHOICE_FIELDS.some((name) => name in (action.inputSchema.properties ?? {}))

  useLayoutEffect(() => {
    formRef.current?.querySelector<HTMLElement>('.workspace-action-fields input, .workspace-action-fields textarea, .workspace-action-fields select')
      ?.focus({ preventScroll: true })
  }, [])

  return <form ref={formRef} id={WORKSPACE_ACTION_FORM_ID} className="workspace-action-form" data-action-id={action.id} noValidate
    onSubmit={(event) => event.preventDefault()}>
    <div className="workspace-action-heading">
      <button type="button" className="workspace-actions-back" disabled={busy} onClick={onBack}><ArrowLeft size={13} />All actions</button>
      <code>{action.command}</code>
    </div>
    <p className="workspace-action-description">{action.description}</p>
    <WorkspaceActionVariants action={action} variants={variants} values={values} busy={busy} onOpenAction={onOpenAction} />
    <div className="workspace-action-fields">
      {cropMedia && <WorkspaceCropPreview media={cropMedia} values={values} disabled={busy} onChange={onPatch} />}
      {entityEditor && <WorkspaceEntityPicker context={context} entityId={entityId} busy={busy} onPatch={onPatch} />}
      {workspaceActionFields(action).map(([name, schema]) => {
        const entityField = entityEditor && name === 'entity'
        return <WorkspaceActionField key={entityField ? `${name}:${entityId}` : name} name={name} schema={entityField ? ENTITY_EDITOR_SCHEMA : schema}
          value={values[name]} choices={choices} required={required.has(name)}
          disabled={busy || (name === 'aspect_ratio' && Boolean(frameAspectRatio))}
          onChange={(value) => onChange(name, value)} />
      })}
    </div>
    {workspaceActionSeedanceEdit(draft) && <p role="status">{SEEDANCE_EDIT_DESCRIPTION}</p>}
    {frameAspectRatio && <p role="status">{FRAME_ASPECT_DESCRIPTION}</p>}
    {hasDependentChoices && <button type="button" disabled={busy} onClick={() => onOpenAction(action.id, values)}>Refresh available choices</button>}
    {review && <div className="workspace-action-review" role="status"><strong>{review.cost ?? 'Review action'}</strong><p>{review.message}</p></div>}
    {result && <WorkspaceActionResultSection action={action} result={result} values={values} onOpenAction={onOpenAction} />}
  </form>
}

export function WorkspaceActionSheet(props: WorkspaceActionSheetProps) {
  const { action, draft, review, result, loading, error, busy, applyFormId, context, onCancel, onCancelReview } = props
  const validation = workspaceActionValidation({ action, context, loading, error, ready: Boolean(draft) })
  return <ConfirmSheet
    kind="workspace-action"
    ariaLabel="Workspace action review"
    tag={action ? `ACTION · ${action.group.toUpperCase()}` : 'ACTION'}
    title={action?.title ?? 'Action'}
    effect={workspaceActionEffect(action)}
    validation={validation}
    busy={busy}
    applyLabel={action ? workspaceActionApplyLabel(action, review) : 'Run action'}
    busyLabel={review || action?.confirmation === 'none' ? 'Running…' : 'Reviewing…'}
    cancelLabel={result ? 'Close' : 'Cancel'}
    applyFormId={applyFormId}
    onCancel={onCancel}
    secondaryActions={review
      ? <button type="button" className="confirm-sheet-secondary" disabled={busy} onClick={onCancelReview}>Cancel review</button>
      : null}
  >
    {action && draft && !loading
      ? <WorkspaceActionBody {...props} action={action} draft={draft} />
      : !loading && <div className="workspace-action-heading">
        <button type="button" className="workspace-actions-back" onClick={props.onBack}><ArrowLeft size={13} />All actions</button>
      </div>}
  </ConfirmSheet>
}

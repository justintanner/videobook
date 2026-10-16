import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Play, X } from 'lucide-react'
import type { WorkspaceAction } from '../../../server/src/workspace-action-contract'
import { frameAspectRatio as modelFrameAspectRatio, FRAME_ASPECT_DESCRIPTION } from '../../../server/src/media/frame-options'
import {
  actionFieldLabel,
  actionUnavailableReason,
  initialActionValues,
  hasWorkspaceActionResultLinks,
  workspaceCropPreset,
} from '@/videobook/workspace-actions'
import type { WorkspaceActionContext } from '@/videobook/workspace-actions'
import { captureDismissedComposerFocus } from '@/videobook/command-composer-focus'
import { WorkspaceActionField } from './WorkspaceActionField'
import { BusyIndicator } from './BusyIndicator'
import { WorkspaceActionResultLinks } from './WorkspaceActionResultLinks'
import { WorkspaceCropPreview } from './WorkspaceCropPreview'
import './workspace-actions.css'

export type WorkspaceActionResult = { message: string; value?: unknown }
export type WorkspaceActionReview = { message: string; cost?: string }

type WorkspaceActionsDialogProps = {
  actions: readonly WorkspaceAction[]
  context: WorkspaceActionContext
  initialActionId: string
  initialValues?: Record<string, unknown>
  initialResult?: WorkspaceActionResult
  returnFocus: HTMLElement | null
  loading?: boolean
  error?: string | null
  onClose: () => void
  onBack: () => void
  onOpenAction: (actionId: string | undefined, values: Record<string, unknown>) => void
  onExecute: (action: WorkspaceAction, values: Record<string, unknown>) => Promise<WorkspaceActionResult>
  onReview: (action: WorkspaceAction, values: Record<string, unknown>) => Promise<WorkspaceActionReview>
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

function ActionForm({ action, context, initialValues, initialResult, variants, onExecute, onReview, onBack, onOpenAction }: {
  action: WorkspaceAction
  context: WorkspaceActionContext
  initialValues?: Record<string, unknown>
  initialResult?: WorkspaceActionResult
  variants: readonly WorkspaceAction[]
  onExecute: WorkspaceActionsDialogProps['onExecute']
  onReview: WorkspaceActionsDialogProps['onReview']
  onBack: () => void
  onOpenAction: WorkspaceActionsDialogProps['onOpenAction']
}) {
  const [draftValues, setValues] = useState(() => {
    const seeded = initialActionValues(action, {
      ...context,
      assetId: typeof initialValues?.asset_id === 'string' ? initialValues.asset_id : context.assetId,
      cellId: typeof initialValues?.cell_id === 'string' ? initialValues.cell_id : context.cellId,
      assetIds: Array.isArray(initialValues?.artifact_ids) ? initialValues.artifact_ids.filter((value): value is string => typeof value === 'string') : context.assetIds,
      cellIds: Array.isArray(initialValues?.cell_ids) ? initialValues.cell_ids.filter((value): value is string => typeof value === 'string') : context.cellIds,
    })
    return { ...seeded, ...Object.fromEntries(Object.entries(initialValues ?? {}).filter(([name]) => name in (action.inputSchema.properties ?? {}) && (name !== '_provider' || !action.generation))) }
  })
  const frameAspectRatio = action.generation && typeof draftValues.model === 'string'
    ? modelFrameAspectRatio(draftValues.model, draftValues)
    : undefined
  const values: Record<string, unknown> = frameAspectRatio
    ? { ...draftValues, options: { ...(draftValues.options && typeof draftValues.options === 'object' ? draftValues.options : {}), aspect_ratio: frameAspectRatio } }
    : draftValues
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<WorkspaceActionReview | null>(null)
  const [result, setResult] = useState<WorkspaceActionResult | null>(initialResult ?? null)
  const required = new Set(action.inputSchema.required ?? [])
  const hidden = new Set(['book_id', 'actor', 'source_surface'])
  if (action.generation) hidden.add('_provider')
  const fields = Object.entries(action.inputSchema.properties ?? {}).filter(([name]) => !hidden.has(name))
  const entityEditor = action.handler.kind === 'tool' && /^update_(?:prompt|scene|character)_entity$/u.test(action.handler.tool)
  const entityId = values.entity && typeof values.entity === 'object' && 'id' in values.entity ? String(values.entity.id) : ''
  const unavailable = actionUnavailableReason(action, context)
  const hasDependentChoices = ['commit_hash', 'filename', 'subject_id', 'subject_ids'].some((name) => name in (action.inputSchema.properties ?? {}))
  const cropMedia = action.handler.kind === 'tool' && ['crop_image', 'crop_video'].includes(action.handler.tool) && typeof values.asset_id === 'string' ? context.media?.[values.asset_id] : undefined
  const choices = action.target.argument && action.target.mediaKinds
    ? { ...context.choices, [action.target.argument]: (context.choices[action.target.argument] ?? context.choices.asset_id ?? []).filter((choice) => action.target.mediaKinds?.some((kind) => kind === choice.detail)) }
    : context.choices

  const execute = async () => {
    if (busy || unavailable) return
    setBusy(true)
    setError(null)
    try {
      if (action.confirmation !== 'none' && !review) {
        setReview(await onReview(action, values))
      } else {
        setResult(await onExecute(action, values))
        setReview(null)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <form className="workspace-action-form" data-action-id={action.id} onSubmit={(event) => { event.preventDefault(); void execute() }}>
    <button type="button" className="workspace-actions-back" disabled={busy} onClick={onBack}><ArrowLeft size={15} />All actions</button>
    <div className="workspace-action-heading"><h3>{action.title}</h3><code>{action.command}</code></div>
    <p>{action.description}</p>
    {variants.length > 1 && <details className="workspace-action-variants"><summary>Advanced provider and model</summary>
      <label>Provider and model<select aria-label="Provider and model" value={action.id} disabled={busy} onChange={(event) => onOpenAction(event.target.value, values)}>
        {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.generation?.provider} · {variant.title}</option>)}
      </select></label>
    </details>}
    <div className="workspace-action-fields">
      {cropMedia && <WorkspaceCropPreview media={cropMedia} values={values} disabled={busy} onChange={(patch) => { setValues((current) => ({ ...current, ...patch })); setReview(null); setResult(null) }} />}
      {entityEditor && <label className="workspace-action-field">Saved item<select aria-label="Saved item" required value={entityId} disabled={busy}
        onChange={(event) => { setValues((current) => ({ ...current, entity: structuredClone(context.entities?.[event.target.value]) })); setResult(null); setReview(null) }}>
        <option value="">Choose a saved item</option>{(context.choices.entity_id ?? []).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select></label>}
      {fields.map(([name, schema]) => <WorkspaceActionField key={entityEditor && name === 'entity' ? `${name}:${entityId}` : name} name={name} schema={entityEditor && name === 'entity' ? {
        type: 'object', required: ['name'], properties: {
          name: { type: 'string', minLength: 1 }, description: { type: 'string' }, prompt: { type: 'string' },
          data: { type: 'object', description: 'Optional advanced saved-item data', additionalProperties: true },
        },
      } : schema} value={values[name]}
        choices={choices} required={required.has(name)} disabled={busy || (name === 'aspect_ratio' && Boolean(frameAspectRatio))}
        onChange={(value) => {
          setValues((current) => ({ ...current, [name]: value,
            ...(cropMedia && name === 'ratio' && typeof value === 'string' ? workspaceCropPreset(value, cropMedia.width, cropMedia.height) : {}),
            ...(name === action.target.argument && typeof value === 'string' && action.inputSchema.properties?.object_hash ? { object_hash: context.media?.[value]?.objectHash ?? '' } : {}),
          }))
          setReview(null)
          setResult(null)
        }} />)}
    </div>
    {frameAspectRatio && <p role="status">{FRAME_ASPECT_DESCRIPTION}</p>}
    {hasDependentChoices && <button type="button" disabled={busy} onClick={() => onOpenAction(action.id, values)}>Refresh available choices</button>}
    {unavailable && <p role="status">{unavailable}</p>}
    {error && <p role="alert" className="workspace-action-error">{error}</p>}
    {review && <div className="workspace-action-review" role="status"><strong>{review.cost ?? 'Review action'}</strong><p>{review.message}</p></div>}
    {result && <section className="workspace-action-result" aria-label="Action result"><p role="status">{result.message}</p>
      {hasWorkspaceActionResultLinks(action) ? <WorkspaceActionResultLinks action={action} value={result.value} values={values} onOpen={onOpenAction} /> : <ResultValue value={result.value} />}
    </section>}
    <footer>
      <button type="submit" className="workspace-action-submit" disabled={busy || Boolean(unavailable)}>
        {busy ? <BusyIndicator size={15} /> : <Play size={15} />}
        {busy ? 'Working…' : review ? 'Confirm and run' : action.confirmation !== 'none' ? 'Review action' : 'Run action'}
      </button>
      {review && <button type="button" onClick={() => setReview(null)} disabled={busy}>Cancel review</button>}
    </footer>
  </form>
}

export function WorkspaceActionsDialog({
  actions,
  context,
  initialActionId,
  initialValues,
  initialResult,
  returnFocus,
  loading = false,
  error,
  onClose,
  onBack,
  onOpenAction,
  onExecute,
  onReview,
}: WorkspaceActionsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const selected = actions.find(action => action.id === initialActionId)
  const activeActionId = selected?.id
  const variants = useMemo(() => selected?.generation ? actions.filter(action => action.generation?.operation === selected.generation?.operation && action.generation?.mediaType === selected.generation?.mediaType) : [], [actions, selected])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])

  useLayoutEffect(() => {
    if (loading) return
    dialogRef.current?.querySelector<HTMLElement>('.workspace-action-fields input, .workspace-action-fields textarea, .workspace-action-fields select')?.focus()
  }, [activeActionId, loading])

  const close = () => {
    const restoreFocus = captureDismissedComposerFocus(returnFocus)
    onClose()
    restoreFocus()
  }

  return createPortal(<dialog ref={dialogRef} className="workspace-actions-dialog" aria-label="Workspace actions"
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }}
    onCancel={event => { event.preventDefault(); close() }}>
    <header><h2>Actions</h2><button type="button" aria-label="Close actions" onClick={close}><X size={18} /></button></header>
    {loading && <p role="status">Loading action…</p>}
    {error && <p role="alert" className="workspace-action-error">{error}</p>}
    {selected && !loading && <ActionForm key={selected.id} action={selected} context={context}
      initialValues={initialValues} initialResult={initialResult} variants={variants}
      onExecute={onExecute} onReview={onReview} onBack={onBack} onOpenAction={onOpenAction} />}
    {!selected && !loading && <p role="alert">This action is no longer available. <button type="button" onClick={onBack}>All actions</button></p>}
  </dialog>, document.body)
}

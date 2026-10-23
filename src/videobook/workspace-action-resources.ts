import { parseFrontierRankings } from './generation-frontier'
import type { WorkspaceAction } from '../../server/src/workspace-action-contract'
import type { ActionChoice } from './workspace-actions'

export type WorkspaceActionResources = {
  choices: Record<string, readonly ActionChoice[]>
  entities: Record<string, Record<string, unknown>>
  values: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  const entries = Array.isArray(value) ? value : record(value)?.[key]
  return Array.isArray(entries) ? entries.flatMap((entry) => { const item = record(entry); return item ? [item] : [] }) : []
}

function choices(entries: Record<string, unknown>[], idKeys: string[], labelKeys: string[]): ActionChoice[] {
  return entries.flatMap((entry) => {
    const id = idKeys.map((key) => entry[key]).find((value): value is string => typeof value === 'string' && Boolean(value))
    if (!id) return []
    const label = labelKeys.map((key) => entry[key]).find((value): value is string => typeof value === 'string' && Boolean(value)) ?? id
    const detail = [entry.type, entry.status, entry.createdAt ?? entry.date].filter((value) => typeof value === 'string').join(' · ')
    return [{ value: id, label, ...(detail ? { detail } : {}) }]
  })
}

export async function loadWorkspaceActionResources(
  action: WorkspaceAction,
  values: Record<string, unknown>,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<WorkspaceActionResources> {
  const fields = action.inputSchema.properties ?? {}
  const tool = action.handler.kind === 'tool' ? action.handler.tool : ''
  const result: WorkspaceActionResources = { choices: {}, entities: {}, values: {} }
  let historicalFiles: ActionChoice[] = []
  const requests: Promise<void>[] = []
  if (fields.notebook_id) requests.push((async () => {
    result.choices.notebook_id = choices(rows(await call('list_notebooks', {}), 'notebooks'), ['id'], ['name'])
  })())
  if (/^(?:get|update|delete)_entity$/u.test(tool)) requests.push((async () => {
    const entries = rows(await call('list_entities', {}), 'entities')
    result.choices.entity_id = choices(entries, ['id'], ['name'])
    result.entities = Object.fromEntries(entries.filter((entry) => typeof entry.id === 'string').map((entry) => [String(entry.id), entry]))
    if (tool.startsWith('update_') && typeof values.entity_id === 'string' && result.entities[values.entity_id]) result.values.entity = result.entities[values.entity_id]
  })())
  if (fields.job_id) requests.push((async () => {
    result.choices.job_id = choices(rows(await call('list_jobs', { limit: 200 }), 'jobs'), ['id', 'jobId'], ['name', 'type', 'tool'])
  })())
  if (fields.archive_ids) requests.push((async () => {
    result.choices.archive_ids = choices(rows(await call('search_archive', { limit: 100, presign_media: false }), 'results'), ['archive_id'], ['title', 'filename'])
  })())
  const reference = values.asset_id ?? values.artifact_id
  const assetId = typeof reference === 'string' ? reference : undefined
  if (fields.commit_hash || fields.target_revision || fields.action_id || fields.target_action_id) requests.push((async () => {
    const history = assetId && fields.commit_hash
      ? rows(await call('asset_history', { asset_id: assetId, limit: 200 }), 'commits')
      : rows(await call('list_book_actions', { limit: 200 }), 'actions')
    const revisions = choices(history, ['hash', 'revision'], ['message', 'operation'])
    result.choices.commit_hash = revisions
    result.choices.target_revision = revisions
    const edits = history.flatMap((entry) => {
      const actionId = record(entry.details)?.actionId
      return typeof actionId === 'string' ? [{ ...entry, actionId }] : []
    })
    const editActions = choices(edits, ['actionId'], ['operation', 'message'])
    result.choices.action_id = tool === 'get_history_action'
      ? choices(history, ['hash', 'revision'], ['operation', 'message']) : editActions
    result.choices.target_action_id = editActions
    if (tool === 'read_file_at_commit') historicalFiles = choices(history.flatMap((entry) => {
      const path = record(entry.details)?.path
      return typeof path === 'string' ? [{ name: path }] : []
    }), ['name'], ['name'])
  })())
  if (fields.filename && assetId && ['read_file_at_commit', 'export_asset_file'].includes(tool)) requests.push((async () => {
    result.choices.filename = choices(rows(await call('asset_manifest', { asset_id: assetId }), 'files'), ['name'], ['name'])
  })())
  if (fields.plan_id && typeof values.notebook_id === 'string') requests.push((async () => {
    const plans = rows(await call(tool.includes('generation') || tool === 'continue_notebook_generation' ? 'list_notebook_generation_plans' : 'list_notebook_run_plans', { notebook_id: values.notebook_id }), 'plans')
    result.choices.plan_id = choices(plans, ['planId', 'plan_id'], ['prompt', 'status'])
  })())
  if (fields.model && action.generation) requests.push((async () => {
    const models = rows(await call('list_generation_models', { media: action.generation?.mediaType }), 'models')
    result.choices.model = models.flatMap(model => choices([model], ['id'], ['title']).map(choice => ({
      ...choice,
      ...(typeof model.available === 'boolean' ? { available: model.available } : {}),
      frontier: parseFrontierRankings(model.frontier),
    })))
  })())
  if (fields.voice_id) requests.push((async () => {
    result.choices.voice_id = choices(rows(await call('list_elevenlabs_voices', {}), 'voices'), ['voice_id', 'id'], ['name'])
  })())
  if ((fields.subject_ids || fields.subject_id) && assetId && typeof values.object_hash === 'string') requests.push((async () => {
    const subjects = rows(await call('get_image_subject_map', { artifact_id: assetId, object_hash: values.object_hash }), 'subjects')
    result.choices.subject_id = choices(subjects, ['id', 'subjectId'], ['label', 'name'])
    result.choices.subject_ids = result.choices.subject_id
  })())
  const settled = await Promise.allSettled(requests)
  const errors = settled.flatMap((entry) => entry.status === 'rejected' ? [entry.reason instanceof Error ? entry.reason.message : String(entry.reason)] : [])
  if (errors.length) throw new Error(`Could not load action choices: ${errors.join(' · ')}`)
  if (historicalFiles.length) {
    const files = new Map((result.choices.filename ?? []).map((file) => [file.value, file]))
    for (const file of historicalFiles) if (!files.has(file.value)) files.set(file.value, { ...file, detail: 'Historical file' })
    result.choices.filename = [...files.values()]
  }
  return result
}

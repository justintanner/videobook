import type { WorkspaceAction } from '../../../server/src/workspace-action-contract'

type OpenAction = (actionId: string | undefined, values: Record<string, unknown>) => void

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function entries(value: unknown, key: string): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : record(value)?.[key]
  return Array.isArray(list) ? list.flatMap((entry) => { const item = record(entry); return item ? [item] : [] }) : []
}

export function WorkspaceActionResultLinks({ action, value, values, onOpen }: {
  action: WorkspaceAction
  value: unknown
  values: Record<string, unknown>
  onOpen: OpenAction
}) {
  if (action.handler.kind !== 'tool') return null
  const tool = action.handler.tool
  if (tool === 'list_entities') return <ul className="workspace-action-linked-results">{entries(value, 'entities').map((entity) => <li key={String(entity.id)}>
    <strong>{String(entity.name)}</strong><span>{String(entity.prompt ?? entity.description ?? '')}</span>
    <div><button type="button" onClick={() => onOpen('tool.update_entity', { entity_id: entity.id })}>Edit</button>
      <button type="button" onClick={() => onOpen('tool.delete_entity', { entity_id: entity.id })}>Delete saved item</button></div>
  </li>)}</ul>
  if (tool === 'list_notebooks') return <ul className="workspace-action-linked-results">{entries(value, 'notebooks').map((notebook) => <li key={String(notebook.id)}>
    <strong>{String(notebook.name)}</strong><div>
      <button type="button" onClick={() => onOpen('tool.get_notebook', { notebook_id: notebook.id })}>Open notebook</button>
      <button type="button" onClick={() => onOpen('tool.rename_notebook', { notebook_id: notebook.id, name: notebook.name })}>Rename</button>
      <button type="button" onClick={() => onOpen('tool.delete_notebook', { notebook_id: notebook.id })}>Delete notebook</button>
    </div>
  </li>)}</ul>
  if (tool === 'asset_history' || tool === 'list_book_actions') return <ul className="workspace-action-linked-results">{entries(value, tool === 'asset_history' ? 'commits' : 'actions').map((revision, index) => {
    const hash = revision.hash ?? revision.revision
    return <li key={String(hash ?? index)}><strong>{String(revision.message ?? revision.operation ?? 'Revision')}</strong><span>{String(revision.date ?? revision.createdAt ?? '')}</span><div>
      <button type="button" onClick={() => onOpen(tool === 'asset_history' ? 'tool.read_file_at_commit' : 'tool.get_history_action', {
        ...values, commit_hash: hash, action_id: revision.actionId ?? revision.id ?? hash,
      })}>Preview revision</button>
      <button type="button" onClick={() => onOpen(tool === 'asset_history' ? 'tool.restore_asset_version' : 'tool.restore_edit_action', {
        ...values, commit_hash: hash, target_revision: hash,
      })}>Restore revision</button>
    </div></li>
  })}</ul>
  if (tool === 'search_archive') return <ul className="workspace-action-linked-results">{entries(value, 'results').map((clip) => <li key={String(clip.archive_id)}>
    <strong>{String(clip.title ?? clip.archive_id)}</strong><span>{String(clip.transcript_excerpt ?? '')}</span><div>
      {typeof clip.media_url === 'string' && <a href={clip.media_url} target="_blank" rel="noreferrer">Preview media</a>}
      <button type="button" onClick={() => onOpen('tool.restore_archive_clips', { archive_ids: [clip.archive_id] })}>Restore to project</button>
    </div>
  </li>)}</ul>
  return null
}

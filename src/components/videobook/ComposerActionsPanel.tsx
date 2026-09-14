import { X } from 'lucide-react'
import type { WorkspaceAction } from '../../../server/src/workspace-action-contract'
import { actionUnavailableReason, type WorkspaceActionContext } from '@/videobook/workspace-actions'

export function ComposerActionsPanel({ actions, groups, group, context, loading, error, listId, selectedIndex,
  onGroupChange, onClose, onSelect }: {
  actions: readonly WorkspaceAction[]
  groups: readonly string[]
  group: string
  context: WorkspaceActionContext
  loading: boolean
  error: string | null
  listId: string
  selectedIndex: number
  onGroupChange: (group: string) => void
  onClose: () => void
  onSelect: (action: WorkspaceAction) => void
}) {
  return <section className="command-suggestions composer-actions-panel" aria-label="Actions" data-workspace-action-surface="launcher">
    <header>
      <strong>Actions</strong>
      <label>Category<select aria-label="Action category" value={group} onChange={event => onGroupChange(event.target.value)}>
        <option value="">All categories</option>{groups.map(name => <option key={name}>{name}</option>)}
      </select></label>
      <span role="status">{loading ? 'Loading actions…' : `${actions.length} actions`}</span>
      <button type="button" aria-label="Close action search" onClick={onClose}><X size={15} /></button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div id={listId} role="listbox" aria-label="Available actions" className="workspace-actions-list">
      {actions.map((action, index) => {
        const unavailable = actionUnavailableReason(action, context)
        return <button type="button" role="option" id={`${listId}-option-${index}`} key={action.id}
          aria-selected={index === selectedIndex} className={index === selectedIndex ? 'active' : ''}
          data-action-id={action.id} data-command={action.command}
          onMouseDown={event => event.preventDefault()} onClick={() => onSelect(action)}>
          <span><strong>{action.title}</strong><code>{action.command}</code></span>
          <small>{action.description}</small>
          {unavailable && <small className="composer-action-unavailable">{unavailable}</small>}
        </button>
      })}
      {!loading && !actions.length && <p>No matching actions. Try an operation, media type or command alias.</p>}
    </div>
    <p className="composer-actions-help">Choose an action to prepare its command. Submit when ready.</p>
  </section>
}

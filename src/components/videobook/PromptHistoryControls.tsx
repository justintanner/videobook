import { useState, type FocusEvent, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, History, Pin, Search, X } from 'lucide-react'
import {
  filterPromptHistory,
  pinnedFirst,
  promptHistoryAge,
  promptHistorySurfaceLabel,
  type PromptHistoryEntry,
} from '@/videobook/generation-prompt-history'
import type { PromptHistoryControl } from '@/videobook/use-prompt-history'
import './PromptHistoryControls.css'

type PromptHistoryControlsProps = {
  history: PromptHistoryControl
  disabled?: boolean
}

function SegmentButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="prompt-history-segment"
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function HistoryRow({
  active,
  entry,
  now,
  pinned,
  showBook,
  onPin,
  onUse,
}: {
  active: boolean
  entry: PromptHistoryEntry
  now: number
  pinned: boolean
  showBook: boolean
  onPin: () => void
  onUse: () => void
}) {
  return (
    <li className="prompt-history-row" data-active={active || undefined}>
      <button type="button" className="prompt-history-use" title="Use this prompt" onClick={onUse}>
        <span className="prompt-history-text">{entry.prompt}</span>
        <span className="prompt-history-meta">
          <span className="prompt-history-surface">{promptHistorySurfaceLabel(entry.surface)}</span>
          {entry.model && <span>{entry.model}</span>}
          {showBook && entry.book && <span className="prompt-history-faint">{entry.book}</span>}
          <span className="prompt-history-faint">{promptHistoryAge(entry.createdAt, now)}</span>
        </span>
      </button>
      <button
        type="button"
        className="prompt-history-icon"
        aria-pressed={pinned}
        aria-label={pinned ? 'Unpin prompt' : 'Pin prompt'}
        title={pinned ? 'Unpin prompt' : 'Pin prompt'}
        onClick={onPin}
      >
        <Pin size={11} aria-hidden="true" />
      </button>
    </li>
  )
}

function HistoryPopover({ history }: { history: PromptHistoryControl }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const visible = pinnedFirst(filterPromptHistory(history.entries ?? [], history.query), history.pins)
  const active = Math.min(activeIndex, Math.max(0, visible.length - 1))
  const now = history.loadedAt
  const surfaceLabel = promptHistorySurfaceLabel(history.surface)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      history.close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(Math.min(Math.max(active + delta, 0), Math.max(0, visible.length - 1)))
      return
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      const entry = visible[active]
      if (!entry) return
      event.preventDefault()
      event.stopPropagation()
      history.use(entry.prompt)
    }
  }

  return (
    <div className="prompt-history-popover" role="dialog" aria-label="Prompt history" onKeyDown={onKeyDown}>
      <div className="prompt-history-head">
        <div className="prompt-history-title">
          <span className="confirm-section-label">Prompt history</span>
          <span className="prompt-history-faint">newest first</span>
          <button
            type="button"
            className="prompt-history-icon"
            aria-label="Close history"
            onClick={history.close}
          >
            <X size={10} aria-hidden="true" />
          </button>
        </div>
        <div className="prompt-history-filters">
          <label className="prompt-history-search">
            <Search size={11} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search prompts"
              placeholder="Search prompts…"
              autoFocus
              value={history.query}
              onChange={(event) => {
                history.setQuery(event.target.value)
                setActiveIndex(0)
              }}
            />
          </label>
          <span className="prompt-history-segments" role="group" aria-label="Scope">
            <SegmentButton active={history.scope === 'book'} label="This book" onClick={() => history.setScope('book')} />
            <SegmentButton active={history.scope === 'library'} label="All books" onClick={() => history.setScope('library')} />
          </span>
          <span className="prompt-history-segments" role="group" aria-label="Surface">
            <SegmentButton
              active={history.surfaceFilter === 'surface'}
              label={surfaceLabel}
              onClick={() => history.setSurfaceFilter('surface')}
            />
            <SegmentButton
              active={history.surfaceFilter === 'all'}
              label="All surfaces"
              onClick={() => history.setSurfaceFilter('all')}
            />
          </span>
        </div>
      </div>
      <ul className="prompt-history-list" aria-busy={history.loading}>
        {visible.map((entry, index) => (
          <HistoryRow
            key={`${entry.book}:${entry.id}`}
            active={index === active}
            entry={entry}
            now={now}
            pinned={history.pins.has(entry.prompt)}
            showBook={history.scope === 'library'}
            onPin={() => history.togglePin(entry.prompt)}
            onUse={() => history.use(entry.prompt)}
          />
        ))}
        {visible.length === 0 && (
          <li className="prompt-history-empty" role={history.error ? 'alert' : 'status'}>
            {history.error
              ?? (history.loading
                ? 'Loading prompts…'
                : history.entries?.length
                  ? 'No prompts match. Clear the search.'
                  : 'No prompts yet. Widen the scope or generate something.')}
          </li>
        )}
      </ul>
      <div className="prompt-history-foot">
        <span>
          <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> use · <kbd>⌥↑</kbd><kbd>⌥↓</kbd> step in the prompt · <kbd>esc</kbd> close
        </span>
        <span>{visible.length} of {history.entries?.length ?? 0}</span>
      </div>
    </div>
  )
}

export function PromptHistoryControls({ history, disabled = false }: PromptHistoryControlsProps) {
  const off = disabled || !history.available
  const closeOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!history.open) return
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    history.close()
  }
  return (
    <div className="prompt-history-controls" onBlur={closeOnBlur}>
      {history.stepping && (
        <span className="prompt-history-status" role="status">
          History {history.position} · esc restores draft
        </span>
      )}
      <span className="prompt-history-steppers">
        <button
          type="button"
          className="prompt-history-icon"
          aria-label="Older prompt"
          title="Older prompt (⌥↑)"
          aria-keyshortcuts="Alt+ArrowUp"
          disabled={off || !history.canOlder}
          onClick={history.older}
        >
          <ChevronLeft size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="prompt-history-icon"
          aria-label="Newer prompt"
          title="Newer prompt (⌥↓)"
          aria-keyshortcuts="Alt+ArrowDown"
          disabled={off || !history.canNewer}
          onClick={history.newer}
        >
          <ChevronRight size={12} aria-hidden="true" />
        </button>
      </span>
      <button
        type="button"
        className="prompt-history-toggle"
        aria-expanded={history.open}
        aria-haspopup="dialog"
        disabled={off}
        onClick={history.toggleOpen}
      >
        <History size={11} aria-hidden="true" />
        <span>History</span>
        {history.entries && <span className="prompt-history-count">{history.entries.length}</span>}
      </button>
      {history.open && <HistoryPopover history={history} />}
    </div>
  )
}

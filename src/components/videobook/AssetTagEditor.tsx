import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import { TAG_FACETS, type TagFacet } from 'videobook-engine/tag-values'
import { orderedTags, type AssetTag, type AssetTags } from '@/videobook/asset-tags'
import {
  tagOriginLabel,
  type TagSuggestion,
} from '@/videobook/asset-tag-editing'

/**
 * The tag editor, used wherever an asset is inspected.
 *
 * Chips carry their origin as a visible affordance and an accessible name —
 * "Kitchen, from analysis" — so someone can tell a machine's guess from their
 * own decision without being shown a model name or a confidence score, which
 * would be runtime detail dressed up as meaning.
 *
 * Dismissed tags stay listed rather than disappearing, because removing an
 * automatic tag is a decision a person may want to take back, and a tag that
 * silently vanished offers nothing to take back.
 */

type AssetTagEditorProps = {
  tags: AssetTags | null
  busy: boolean
  error: string | null
  canEdit: boolean
  suggestions: TagSuggestion[]
  onAdd: (edit: { facet: TagFacet; label: string }) => void
  onRemove: (edit: { facet: TagFacet; label: string }) => void
  onRestore: (edit: { facet: TagFacet; label: string }) => void
  onQueryChange: (prefix: string, facet: TagFacet) => void
  /** Shown when automatic tagging has not produced anything for this asset. */
  status?: string | null
  onRetry?: (() => void) | undefined
}

const FACET_LABEL: Record<TagFacet, string> = {
  people: 'People',
  places: 'Places',
  editing: 'Editing',
  custom: 'Custom',
}

export function AssetTagEditor({
  tags,
  busy,
  error,
  canEdit,
  suggestions,
  onAdd,
  onRemove,
  onRestore,
  onQueryChange,
  status,
  onRetry,
}: AssetTagEditorProps) {
  const [draft, setDraft] = useState('')
  const [facet, setFacet] = useState<TagFacet>('custom')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = useId()

  const effective = useMemo(
    () => orderedTags(tags?.effective ?? []),
    [tags],
  )
  const dismissed = tags?.dismissed ?? []

  function commitDraft(): void {
    const label = draft.trim()
    if (!label || !canEdit) return
    onAdd({ facet, label })
    setDraft('')
    onQueryChange('', facet)
    // Focus stays in the field so several tags can be typed in a row.
    inputRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitDraft()
      return
    }
    if (event.key === 'Escape' && draft) {
      event.preventDefault()
      setDraft('')
      onQueryChange('', facet)
    }
  }

  return (
    <section className="asset-tag-editor" aria-label="Asset tags">
      <div className="asset-tag-chips" role="list">
        {effective.map((tag: AssetTag) => (
          <span
            className={`asset-tag-chip asset-tag-chip-${tag.origin}`}
            key={`${tag.facet}/${tag.key}`}
            role="listitem"
          >
            <span className="asset-tag-chip-facet">{FACET_LABEL[tag.facet]}</span>
            <span className="asset-tag-chip-label">{tag.label}</span>
            {canEdit
              ? (
                <button
                  type="button"
                  className="asset-tag-chip-remove"
                  onClick={() => onRemove({ facet: tag.facet, label: tag.label })}
                  aria-label={`Remove tag ${tag.label} (${tagOriginLabel(tag)})`}
                  title={tagOriginLabel(tag)}
                >
                  <X size={11} />
                </button>
              )
              : null}
          </span>
        ))}
        {effective.length === 0
          ? (
            <span className="asset-tag-empty">
              {status ?? 'No tags yet'}
            </span>
          )
          : null}
      </div>

      {canEdit
        ? (
          <div className="asset-tag-input-row">
            <label className="asset-tag-facet-label">
              <span className="sr-only">Tag facet</span>
              <select
                className="asset-tag-facet"
                value={facet}
                onChange={(event) => {
                  const next = event.target.value as TagFacet
                  setFacet(next)
                  onQueryChange(draft, next)
                }}
              >
                {TAG_FACETS.map((entry) => (
                  <option key={entry} value={entry}>{FACET_LABEL[entry]}</option>
                ))}
              </select>
            </label>
            <input
              ref={inputRef}
              className="asset-tag-input"
              value={draft}
              list={listId}
              placeholder="Add a tag"
              aria-label="Add a tag"
              autoComplete="off"
              onChange={(event) => {
                setDraft(event.target.value)
                onQueryChange(event.target.value, facet)
              }}
              onKeyDown={handleKeyDown}
            />
            <datalist id={listId}>
              {suggestions.map((suggestion) => (
                <option
                  key={`${suggestion.facet}/${suggestion.key}`}
                  value={suggestion.label}
                >
                  {`${FACET_LABEL[suggestion.facet]} · ${suggestion.assets} asset${suggestion.assets === 1 ? '' : 's'}`}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              className="asset-tag-add"
              onClick={commitDraft}
              disabled={!draft.trim()}
              aria-label="Add tag"
            >
              <Plus size={12} />
            </button>
          </div>
        )
        : null}

      {dismissed.length > 0
        ? (
          <div className="asset-tag-dismissed">
            <span className="asset-tag-dismissed-label">Removed</span>
            <div className="asset-tag-chips" role="list">
              {dismissed.map((tag) => (
                <span
                  className="asset-tag-chip asset-tag-chip-dismissed"
                  key={`dismissed-${tag.facet}/${tag.key}`}
                  role="listitem"
                >
                  <span className="asset-tag-chip-label">{tag.label}</span>
                  {canEdit
                    ? (
                      <button
                        type="button"
                        className="asset-tag-chip-restore"
                        onClick={() =>
                          onRestore({ facet: tag.facet, label: tag.label })}
                        aria-label={`Restore tag ${tag.label}`}
                        title="Restore this tag"
                      >
                        <RotateCcw size={11} />
                      </button>
                    )
                    : null}
                </span>
              ))}
            </div>
          </div>
        )
        : null}

      {error
        ? (
          <p className="asset-tag-error" role="status">
            {error}
            {onRetry
              ? (
                <button
                  type="button"
                  className="asset-tag-retry"
                  onClick={onRetry}
                >
                  Retry
                </button>
              )
              : null}
          </p>
        )
        : null}
      {busy ? <span className="sr-only" role="status">Saving tags</span> : null}
    </section>
  )
}

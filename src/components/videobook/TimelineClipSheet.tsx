import { Film } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ConfirmValidation } from '@/videobook/confirm-validation'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import type { TimelineAsset } from '@/videobook/useTimelineAssembly'
import { ConfirmSheet } from './confirm/ConfirmSheet'
import './TimelineClipSheet.css'

const TIMELINE_CLIP_FORM_ID = 'timeline-clip-form'

type TimelineClipSheetProps = {
  trackName: string
  items: readonly TimelineAsset[]
  selectedArtifactId: string | null
  hasMore: boolean
  busy: boolean
  error: string
  applyFormId?: string
  onSelect: (artifactId: string) => void
  onLoadMore: () => void
  onApply?: () => void
  onCancel: () => void
}

function clipValidation(selected: TimelineAsset | null, error: string): ConfirmValidation {
  if (!selected) return { blocking: error || 'Choose a clip to add.', notice: null }
  return { blocking: null, notice: error || null }
}

export function TimelineClipSheet({
  trackName,
  items,
  selectedArtifactId,
  hasMore,
  busy,
  error,
  applyFormId = TIMELINE_CLIP_FORM_ID,
  onSelect,
  onLoadMore,
  onApply,
  onCancel,
}: TimelineClipSheetProps) {
  const filterRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const selected = items.find((asset) => asset.artifactId === selectedArtifactId) ?? null
  const matches = items.filter((asset) => asset.label.toLowerCase().includes(query.trim().toLowerCase()))

  useLayoutEffect(() => {
    const trigger = document.activeElement
    filterRef.current?.focus({ preventScroll: true })
    return () => restoreFocusElement(trigger instanceof HTMLElement ? trigger : null)
  }, [])

  return <ConfirmSheet
    kind="timeline-clip"
    ariaLabel="Add a timeline clip"
    tag="TIMELINE"
    title={`Add a clip to ${trackName}`}
    address={selected?.label ?? null}
    effect={{ label: 'Appends 1 clip', tone: 'default' }}
    validation={clipValidation(selected, error)}
    busy={busy}
    busyLabel="Updating timeline…"
    applyLabel="Add clip"
    applyFormId={applyFormId}
    onCancel={onCancel}
  >
    <form id={TIMELINE_CLIP_FORM_ID} className="timeline-clip-form" onSubmit={(event) => {
      event.preventDefault()
      if (selected && !busy) onApply?.()
    }}>
      <input ref={filterRef} type="text" aria-label="Filter timeline sources" placeholder="Filter media by name"
        value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="timeline-source-list" role="group" aria-label="Timeline sources">
        {matches.map((asset) => (
          <button key={asset.artifactId} type="button" aria-pressed={asset.artifactId === selectedArtifactId} disabled={busy}
            onClick={() => onSelect(asset.artifactId)}>
            {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <Film size={24} />}
            <span>{asset.label}</span>
          </button>
        ))}
        {matches.length === 0 && <p>No matching media on this page.</p>}
      </div>
      {hasMore && <button type="button" className="timeline-source-more" disabled={busy} onClick={onLoadMore}>Load more media</button>}
    </form>
  </ConfirmSheet>
}

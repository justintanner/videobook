import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Search, X } from 'lucide-react'
import { handleModalDialogKeyDown } from '@/videobook/modal-dialog-interactions'
import { restoreFocusElement } from '@/videobook/command-composer-focus'
import { slotCapacity, slotDropError, type SlotColumn, type SlotEdit } from '@/videobook/generation-slot-layout'
import type { GenerationSlotEditor } from './GenerationInputSlots'
import { MediaLibraryAssetPreview } from './MediaLibraryAssetPreview'
import './GenerationInputPicker.css'

export function GenerationInputPicker({
  busy,
  column,
  editor,
  opener,
  onClose,
}: {
  busy: boolean
  column: SlotColumn
  editor: GenerationSlotEditor
  opener: HTMLButtonElement
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [search, setSearch] = useState('')
  const { spec, items } = column
  const capacity = slotCapacity(spec, editor.context.mode.limits, editor.context.settings)
  const sourceIds = new Set([
    ...editor.board,
    ...editor.layout.slots.flatMap((slot) => slot.items.map((item) => item.sourceCellId)),
    ...editor.layout.unplaced.map((item) => item.sourceCellId),
  ])
  const sources = [...editor.cells.values()].filter((source) =>
    sourceIds.has(source.cellId) && editor.context.kinds.get(source.cellId) === spec.kind)
  const query = search.trim().replace(/^@/, '').toLowerCase()
  const matches = sources.filter((source) => source.address.toLowerCase().includes(query))
  const addEdit = (sourceCellId: string): Extract<SlotEdit, { kind: 'add' }> => ({
    kind: 'add', sourceCellId, to: { target: spec.target, index: items.length },
  })
  const close = () => {
    dialogRef.current?.close()
    onClose()
    restoreFocusElement(opener)
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    searchRef.current?.focus({ preventScroll: true })
    return () => dialog?.close()
  }, [])

  return createPortal(
    <dialog
      ref={dialogRef}
      className="generation-input-picker"
      aria-labelledby={titleId}
      data-composer-focus="preserve"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing) return
        handleModalDialogKeyDown(event, { busy: false, container: dialogRef.current, onClose: close })
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
      }}
    >
      <header className="generation-input-picker-header">
        <div>
          <h2 id={titleId}>Choose {spec.kind} for {spec.label.toLowerCase()}</h2>
          <p>{items.length} added{capacity === null ? '' : ` · ${capacity} maximum`} · Select a cell to add it</p>
        </div>
        <button type="button" aria-label="Close input picker" onClick={close}><X size={18} aria-hidden="true" /></button>
      </header>
      <label className="generation-input-picker-search">
        <Search size={16} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search input cells"
          placeholder="Find a cell, e.g. @c2"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </label>
      <div className="generation-input-picker-results">
        {matches.length === 0 ? (
          <p className="generation-input-picker-empty" role="status">
            {sources.length === 0 ? `No ${spec.kind === 'audio' ? 'audio' : `${spec.kind}s`} available in this notebook.` : 'No cells match this address.'}
          </p>
        ) : (
          <ul className="generation-input-picker-grid">
            {matches.map((source) => {
              const connected = items.some((item) => item.sourceCellId === source.cellId)
              const edit = addEdit(source.cellId)
              const error = slotDropError(editor.layout, edit, editor.context)
              const unavailable = connected ? 'Already added' : error
              return (
                <li key={source.cellId}>
                  <button
                    type="button"
                    className="generation-input-picker-card"
                    disabled={busy || Boolean(unavailable)}
                    data-connected={connected ? 'true' : undefined}
                    aria-label={`Add @${source.address} to ${spec.label}`}
                    title={unavailable ?? `Add @${source.address} to ${spec.label}`}
                    onClick={() => {
                      if (busy || slotDropError(editor.layout, edit, editor.context)) return
                      close()
                      editor.onEdit(edit)
                    }}
                  >
                    <span className="generation-input-picker-preview">
                      <MediaLibraryAssetPreview asset={source.asset ?? { type: spec.kind, mediaUrl: null, thumbnailUrl: null, duration: null }} />
                      {connected && <span className="generation-input-picker-selected"><Check size={18} aria-hidden="true" /></span>}
                    </span>
                    <span className="generation-input-picker-copy">
                      <strong>@{source.address}</strong>
                      <small>{unavailable ?? source.type.replaceAll('_', ' ')}</small>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </dialog>,
    document.body,
  )
}

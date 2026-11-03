import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { GripVertical, X } from 'lucide-react'
import { MediaLibraryAssetPreview } from '@/components/videobook/MediaLibraryAssetPreview'
import type { GenerationReviewSource } from '@/components/videobook/confirm/bodies/GenerationBody'
import {
  activeCellRefDrag,
  endCellRefDrag,
  startCellRefDrag,
  type CellRefDrag,
} from '@/videobook/cell-ref-drag'
import {
  slotCapacity,
  slotDropError,
  slotItemPlaceholder,
  slotLayoutLimitMessages,
  type SlotColumn,
  type SlotEdit,
  type SlotItem,
  type SlotLayout,
  type SlotLayoutContext,
  type SlotPosition,
} from '@/videobook/generation-slot-layout'
import type { ItemParamSpec } from '../../../server/src/media/types'

export type GenerationSlotEditor = {
  layout: SlotLayout
  context: SlotLayoutContext
  cells: ReadonlyMap<string, GenerationReviewSource>
  tokens: ReadonlyMap<string, string>
  board: readonly string[]
  onEdit: (edit: SlotEdit) => void
}

type DropEdit = Extract<SlotEdit, { kind: 'move' | 'add' }>

type DropHover = {
  target: string | null
  index: number
  error: string | null
}

type SlotHandlers = {
  busy: boolean
  hover: DropHover | null
  beginDrag: (event: DragEvent<HTMLElement>, drag: CellRefDrag) => void
  finishDrag: () => void
  dragOver: (event: DragEvent<HTMLElement>, to: SlotPosition) => void
  drop: (event: DragEvent<HTMLElement>, to: SlotPosition) => void
  keyDown: (event: KeyboardEvent<HTMLElement>, from: SlotPosition) => void
  focusRef: (key: string) => (node: HTMLButtonElement | null) => void
  onEdit: (edit: SlotEdit) => void
  onSelectSource: (cellId: string) => void
}

function dropEdit(drag: CellRefDrag, to: SlotPosition, copy: boolean): DropEdit {
  return drag.from
    ? { kind: 'move', from: drag.from, to, copy }
    : { kind: 'add', sourceCellId: drag.sourceCellId, to }
}

function sameHover(left: DropHover | null, right: DropHover | null): boolean {
  return left?.target === right?.target && left?.index === right?.index && left?.error === right?.error
}

function rowIndex(event: DragEvent<HTMLElement>, index: number): number {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY > rect.top + rect.height / 2 ? index + 1 : index
}

function neighbourSlotMove(
  layout: SlotLayout,
  context: SlotLayoutContext,
  from: SlotPosition,
  step: number,
): SlotEdit | null {
  const order = layout.slots.map((column) => column.spec.target)
  const start = from.target === null ? (step < 0 ? order.length : -1) : order.indexOf(from.target)
  for (let index = start + step; index >= 0 && index < order.length; index += step) {
    const column = layout.slots[index]!
    const edit: DropEdit = { kind: 'move', from, to: { target: column.spec.target, index: column.items.length }, copy: false }
    if (!slotDropError(layout, edit, context)) return edit
  }
  return null
}

function keyboardEdit(
  layout: SlotLayout,
  context: SlotLayoutContext,
  from: SlotPosition,
  key: string,
  altKey: boolean,
): SlotEdit | null {
  if (key === 'Delete' || key === 'Backspace') return { kind: 'remove', from }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null
  const step = key === 'ArrowUp' ? -1 : 1
  if (altKey || from.target === null) return neighbourSlotMove(layout, context, from, step)
  const count = layout.slots.find((column) => column.spec.target === from.target)?.items.length ?? 0
  const next = from.index + step
  if (next < 0 || next >= count) return null
  return { kind: 'move', from, to: { target: from.target, index: step < 0 ? next : next + 1 }, copy: false }
}

function itemKey(item: SlotItem, target: string | null): string {
  return `${item.sourceCellId}:${target ?? 'unplaced'}`
}

function formatParam(value: number | undefined): string {
  return value === undefined ? '' : String(Math.round(value * 100) / 100)
}

function SlotParamInput({
  address,
  busy,
  placeholder,
  spec,
  value,
  onCommit,
}: {
  address: string
  busy: boolean
  placeholder: number | undefined
  spec: ItemParamSpec
  value: number | undefined
  onCommit: (value: number | undefined) => void
}) {
  const commit = (raw: string) => {
    const parsed = raw.trim() === '' ? undefined : Number(raw)
    if (parsed !== undefined && !Number.isFinite(parsed)) return
    if (parsed !== value) onCommit(parsed)
  }
  return (
    <label className="generation-slot-param" title={spec.label}>
      <input
        key={formatParam(value)}
        type="number"
        inputMode="decimal"
        step={spec.valueType === 'integer' ? 1 : 0.1}
        min={spec.minimum}
        max={spec.maximum}
        defaultValue={formatParam(value)}
        placeholder={formatParam(placeholder)}
        disabled={busy}
        aria-label={`${spec.label} for @${address}`}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.currentTarget.blur()
        }}
      />
      {spec.unit && <small>{spec.unit}</small>}
    </label>
  )
}

function SlotChip({
  column,
  editor,
  handlers,
  index,
  item,
  target,
}: {
  column: SlotColumn | null
  editor: GenerationSlotEditor
  handlers: SlotHandlers
  index: number
  item: SlotItem
  target: string | null
}) {
  const source = editor.cells.get(item.sourceCellId)
  const address = source?.address ?? item.sourceCellId.slice(-4)
  const token = item.port ? editor.tokens.get(`${item.sourceCellId}:${item.port}`) : undefined
  const position = { target, index }
  const hover = handlers.hover
  const marker = hover && hover.target === target && column
    ? hover.index === index ? 'before' : hover.index === index + 1 ? 'after' : undefined
    : undefined
  return (
    <li
      className="generation-slot-chip"
      data-drop={marker}
      onDragOver={column ? (event) => handlers.dragOver(event, { target, index: rowIndex(event, index) }) : undefined}
      onDrop={column ? (event) => handlers.drop(event, { target, index: rowIndex(event, index) }) : undefined}
    >
      <button
        type="button"
        className="generation-slot-grip"
        draggable={!handlers.busy}
        disabled={handlers.busy}
        ref={handlers.focusRef(itemKey(item, target))}
        aria-label={`Move @${address}`}
        title="Drag to move, Option-drag to copy; arrow keys reorder, Option-arrow keys change slot"
        onDragStart={(event) => handlers.beginDrag(event, { sourceCellId: item.sourceCellId, from: position })}
        onDragEnd={handlers.finishDrag}
        onKeyDown={(event) => handlers.keyDown(event, position)}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="generation-slot-thumb"
        disabled={handlers.busy}
        title={`Select @${address} on the board`}
        onClick={() => handlers.onSelectSource(item.sourceCellId)}
      >
        <MediaLibraryAssetPreview
          asset={source?.asset ?? { type: source?.type ?? item.kind, mediaUrl: null, thumbnailUrl: null, duration: null }}
          eager
        />
      </button>
      <span className="generation-slot-chip-copy">
        <strong>@{token ?? address}</strong>
        <span className="generation-slot-chip-meta">
          <small>{token ? `@${address}` : item.kind}</small>
          {column?.spec.itemParams.map((spec) => (
            <SlotParamInput
              key={spec.name}
              address={address}
              busy={handlers.busy}
              spec={spec}
              value={item.params[spec.name]}
              placeholder={slotItemPlaceholder(spec, column, index, editor.context.settings)}
              onCommit={(value) => handlers.onEdit({ kind: 'params', at: position, name: spec.name, value })}
            />
          ))}
        </span>
      </span>
      <button
        type="button"
        className="generation-slot-remove"
        disabled={handlers.busy}
        aria-label={`Remove @${address} from ${column?.spec.label ?? 'inputs'}`}
        title={`Remove @${address}`}
        onClick={() => handlers.onEdit({ kind: 'remove', from: position })}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}

function SlotSection({
  column,
  editor,
  handlers,
}: {
  column: SlotColumn
  editor: GenerationSlotEditor
  handlers: SlotHandlers
}) {
  const { spec, items } = column
  const capacity = slotCapacity(spec, editor.context.mode.limits, editor.context.settings)
  const hover = handlers.hover?.target === spec.target ? handlers.hover : null
  const end = { target: spec.target, index: items.length }
  return (
    <section
      className="generation-slot"
      aria-label={spec.label}
      data-target={spec.target}
      data-refused={hover?.error ? 'true' : undefined}
      data-hover={hover && !hover.error ? 'true' : undefined}
      onDragOver={(event) => handlers.dragOver(event, end)}
      onDrop={(event) => handlers.drop(event, end)}
    >
      <header className="generation-slot-header">
        <span className="generation-slot-label">{spec.label}</span>
        {spec.fields.length > 0 && (
          <code className="generation-slot-field">{spec.fields.map((field) => field.path).join(' + ')}</code>
        )}
        <span className="generation-slot-count">{items.length}{capacity === null ? '' : `/${capacity}`}</span>
      </header>
      <ol className="generation-slot-items">
        {items.map((item, index) => (
          <SlotChip
            key={item.port ?? `new-${index}`}
            column={column}
            editor={editor}
            handlers={handlers}
            index={index}
            item={item}
            target={spec.target}
          />
        ))}
        {items.length === 0 && (
          <li className="generation-slot-empty" data-drop={hover && !hover.error ? 'before' : undefined}>
            Drop {spec.kind === 'audio' ? 'audio' : `an ${spec.kind}`}
          </li>
        )}
      </ol>
      {hover?.error && <p className="generation-slot-refusal" role="status">{hover.error}</p>}
    </section>
  )
}

function firstAcceptingSlot(editor: GenerationSlotEditor, sourceCellId: string): SlotColumn | undefined {
  return editor.layout.slots.find((column) => !slotDropError(editor.layout, {
    kind: 'add',
    sourceCellId,
    to: { target: column.spec.target, index: column.items.length },
  }, editor.context))
}

function SlotBoard({ editor, handlers }: { editor: GenerationSlotEditor; handlers: SlotHandlers }) {
  if (editor.board.length === 0) return null
  return (
    <div className="generation-slot-board" aria-label="Board cells">
      {editor.board.map((cellId) => {
        const source = editor.cells.get(cellId)
        if (!source) return null
        const slot = firstAcceptingSlot(editor, cellId)
        return (
          <div className="generation-slot-tile" key={cellId}>
            <button
              type="button"
              className="generation-slot-tile-add"
              disabled={handlers.busy || !slot}
              title={slot ? `Add @${source.address} to ${slot.spec.label}` : `No slot takes @${source.address}`}
              onClick={() => {
                if (slot) handlers.onEdit({ kind: 'add', sourceCellId: cellId, to: { target: slot.spec.target, index: slot.items.length } })
              }}
            >
              <span className="generation-slot-thumb">
                <MediaLibraryAssetPreview
                  asset={source.asset ?? { type: source.type, mediaUrl: null, thumbnailUrl: null, duration: null }}
                  eager
                />
              </span>
              <small>@{source.address}</small>
            </button>
            <button
              type="button"
              className="generation-slot-grip generation-slot-tile-grip"
              draggable={!handlers.busy}
              disabled={handlers.busy}
              aria-label={`Drag @${source.address} into a slot`}
              onDragStart={(event) => handlers.beginDrag(event, { sourceCellId: cellId, from: null })}
              onDragEnd={handlers.finishDrag}
            >
              <GripVertical size={11} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function GenerationInputSlots({
  busy,
  editor,
  onSelectSource,
}: {
  busy: boolean
  editor: GenerationSlotEditor
  onSelectSource: (cellId: string) => void
}) {
  const [hover, setHover] = useState<DropHover | null>(null)
  const [dragging, setDragging] = useState<CellRefDrag | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const limitMessages = slotLayoutLimitMessages(editor.layout, editor.context)
  const finishDrag = () => {
    endCellRefDrag()
    setDragging(null)
    setHover(null)
  }
  const dropAt = (event: DragEvent<HTMLElement>, to: SlotPosition) => {
    const drag = activeCellRefDrag(event)
    if (!drag) return null
    const edit = dropEdit(drag, to, event.altKey)
    return { edit, error: slotDropError(editor.layout, edit, editor.context) }
  }
  const handlers: SlotHandlers = {
    busy,
    hover,
    beginDrag: (event, drag) => {
      startCellRefDrag(event, drag)
      const chip = event.currentTarget.closest('.generation-slot-chip, .generation-slot-tile')
      if (chip) event.dataTransfer.setDragImage(chip, 16, 28)
      setDragging(drag)
    },
    finishDrag,
    dragOver: (event, to) => {
      const drop = dropAt(event, to)
      if (!drop) return
      event.stopPropagation()
      const next = { target: to.target, index: to.index, error: drop.error }
      setHover((current) => sameHover(current, next) ? current : next)
      if (drop.error) {
        event.dataTransfer.dropEffect = 'none'
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = drop.edit.kind === 'move' && !drop.edit.copy ? 'move' : 'copy'
    },
    drop: (event, to) => {
      const drop = dropAt(event, to)
      if (!drop) return
      event.preventDefault()
      event.stopPropagation()
      finishDrag()
      if (!drop.error) editor.onEdit(drop.edit)
    },
    keyDown: (event, from) => {
      const edit = keyboardEdit(editor.layout, editor.context, from, event.key, event.altKey)
      if (!edit) return
      event.preventDefault()
      const item = (from.target === null
        ? editor.layout.unplaced
        : editor.layout.slots.find((column) => column.spec.target === from.target)?.items)?.[from.index]
      if (item && edit.kind === 'move') pendingFocus.current = itemKey(item, edit.to.target)
      editor.onEdit(edit)
    },
    focusRef: (key) => (node) => {
      if (!node || pendingFocus.current !== key) return
      pendingFocus.current = null
      node.focus()
    },
    onEdit: editor.onEdit,
    onSelectSource,
  }
  const disconnectFrom = dragging?.from ?? null
  return (
    <div className="generation-slots" data-dragging={dragging ? 'true' : undefined}>
      <SlotBoard editor={editor} handlers={handlers} />
      {editor.layout.slots.map((column) => (
        <SlotSection key={column.spec.target} column={column} editor={editor} handlers={handlers} />
      ))}
      {editor.layout.unplaced.length > 0 && (
        <section className="generation-slot generation-slot-unplaced" aria-label="Not sent">
          <header className="generation-slot-header">
            <span className="generation-slot-label">Not sent with this type</span>
            <span className="generation-slot-count">{editor.layout.unplaced.length}</span>
          </header>
          <ol className="generation-slot-items">
            {editor.layout.unplaced.map((item, index) => (
              <SlotChip
                key={item.port ?? `new-${index}`}
                column={null}
                editor={editor}
                handlers={handlers}
                index={index}
                item={item}
                target={null}
              />
            ))}
          </ol>
        </section>
      )}
      {limitMessages.map((message) => (
        <p key={message} className="generation-slot-limit" role="alert">{message}</p>
      ))}
      {disconnectFrom && (
        <div
          className="generation-slot-disconnect"
          onDragOver={(event) => {
            if (!activeCellRefDrag(event)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(event) => {
            event.preventDefault()
            finishDrag()
            editor.onEdit({ kind: 'remove', from: disconnectFrom })
          }}
        >
          Drop here to disconnect
        </div>
      )}
    </div>
  )
}

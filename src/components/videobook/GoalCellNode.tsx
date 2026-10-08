import { useContext, type KeyboardEvent, type MouseEvent } from 'react'
import { Ellipsis, Flag } from 'lucide-react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNode } from '@/videobook/notebook-canvas'
import { formatGoalClock, goalPlanFromInputs, goalTileView, type GoalTileRow } from '@/videobook/goals'
import { notebookGridTag } from '@/videobook/notebook-grid'
import { useElapsedSeconds } from '@/videobook/use-elapsed-seconds'
import {
  CellContextMenuContext,
  GoalTileContext,
  GoalMediaContext,
  PrimaryCellContext,
  cellContextMenuId,
} from '@/components/videobook/notebook-canvas-context'
import './GoalCellNode.css'

function GoalTileRowView({ row }: { row: GoalTileRow }) {
  const elapsed = useElapsedSeconds(row.startedAt)
  const detail = row.state === 'generating'
    ? elapsed === null ? 'Generating' : formatGoalClock(elapsed)
    : row.detail
  return (
    <li className="goal-tile-row" data-state={row.state}>
      <span className="goal-tile-row-number">{row.number}</span>
      <span className="goal-tile-row-title">{row.title}</span>
      <span className="goal-tile-row-state">{detail}</span>
    </li>
  )
}

function returnFocusTarget(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

export function GoalCellNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const goals = useContext(GoalTileContext)
  const media = useContext(GoalMediaContext)
  const primaryCellId = useContext(PrimaryCellContext)
  const contextMenu = useContext(CellContextMenuContext)
  const goal = goals.get(id) ?? null
  const view = goalTileView(goal, goalPlanFromInputs(data.inputs), data.label)
  const address = notebookGridTag(data.slot)
  const primarySelected = selected && primaryCellId === id
  const openMenuFromPointer = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    contextMenu.open(id, { x: event.clientX, y: event.clientY }, returnFocusTarget())
  }
  const openMenuFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.currentTarget.getBoundingClientRect()
    contextMenu.open(id, { x: bounds.left + Math.min(bounds.width - 12, 40), y: bounds.top + 40 }, returnFocusTarget())
  }

  return (
    <article
      className={[
        'cell-node',
        'cell-kind-goal',
        'cell-family-goal',
        selected ? 'cell-node-selected' : '',
        primarySelected ? 'cell-node-primary' : '',
        view.chip.tone === 'attention' ? 'cell-node-error' : '',
        data.deleting ? 'cell-node-deleting' : '',
        data.revealing ? 'cell-node-created' : '',
        data.highlighted ? 'cell-node-highlight' : '',
      ].filter(Boolean).join(' ')}
      aria-label={`${address} goal: ${view.title}`}
      data-selection={primarySelected ? 'primary' : selected ? 'selected' : undefined}
      data-goal-tone={view.chip.tone}
      data-context-menu-open={contextMenu.openCellId === id ? 'true' : undefined}
      onContextMenu={openMenuFromPointer}
      onKeyDown={openMenuFromKeyboard}
    >
      <section className="cell-node-shell">
        <header className="cell-node-header">
          <span className="cell-node-type" aria-label="GOAL">
            <Flag size={14} />
            <span className="cell-node-type-label" aria-hidden="true">GOAL</span>
          </span>
          {(view.shotsLabel || view.aspectRatio) && (
            <span className="cell-generation-chips">
              {view.shotsLabel && <span className="cell-aspect-ratio" title="Shots">{view.shotsLabel}</span>}
              {view.aspectRatio && <span className="cell-aspect-ratio" title="Aspect ratio">{view.aspectRatio}</span>}
            </span>
          )}
        </header>
        <div className="goal-tile-body">
          <strong className="goal-tile-title" title={view.title}>{view.title}</strong>
          {view.styleLabel && <span className="cell-aspect-ratio goal-style-chip" title="Goal style">{view.styleLabel}</span>}
          {goal && goal.characters.length > 0 && <span className="goal-tile-characters">{goal.characters.length} character{goal.characters.length === 1 ? '' : 's'}</span>}
          {view.thumbnails.length > 0 && <span className="goal-tile-thumbnails">
            {view.thumbnails.map(thumbnail => {
              const asset = media.get(thumbnail.artifactId)
              const url = asset?.thumbnailUrl ?? asset?.mediaUrl
              return url ? <img key={thumbnail.artifactId} src={url} alt={thumbnail.label} /> : null
            })}
          </span>}
          {view.planning ? (
            <>
              {view.note && <p className="goal-tile-brief">{view.note}</p>}
              <span className="goal-tile-placeholder" aria-hidden="true"><i /><i /><i /></span>
            </>
          ) : (
            <>
              <ol className="goal-tile-rows">
                {view.rows.map((row) => <GoalTileRowView key={row.key} row={row} />)}
                {view.hiddenRows > 0 && <li className="goal-tile-more">+{view.hiddenRows} more</li>}
              </ol>
              {view.note && <p className="goal-tile-note" data-tone={view.noteTone}>{view.note}</p>}
            </>
          )}
          <span className="goal-tile-progress" aria-hidden="true">
            <span style={{ width: `${view.progressPercent}%` }} />
          </span>
        </div>
        <footer className="cell-node-footer">
          <strong>{address}</strong>
          <span className="cell-node-footer-actions">
            <span className="goal-tile-chip" data-tone={view.chip.tone}>{view.chip.label}</span>
            <button
              type="button"
              className="cell-context-menu-trigger nodrag"
              aria-label={`Open ${address} cell menu`}
              aria-haspopup="menu"
              aria-expanded={contextMenu.openCellId === id}
              aria-controls={cellContextMenuId(id)}
              title="Cell actions"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                const bounds = event.currentTarget.getBoundingClientRect()
                contextMenu.open(id, { x: bounds.right - 4, y: bounds.bottom + 4 }, event.currentTarget)
              }}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </span>
        </footer>
      </section>
    </article>
  )
}

import { useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import type { AutoEditAnchors, AutoEditCue, AutoEditSections } from '../../../../server/src/auto-edit/style'
import {
  AUTO_EDIT_ANCHOR_INFO,
  AUTO_EDIT_HOOK_ANCHORS,
  AUTO_EDIT_MOMENT_ANCHORS,
  autoEditAnchorSeconds,
  autoEditConnectorClip,
  autoEditEditPercentAt,
  autoEditSoundLabel,
  autoEditSourcePercent,
  autoEditTicks,
  type AutoEditAnchorKey,
  type AutoEditLaneItem,
  type AutoEditTimelineBlock,
} from '@/videobook/auto-edit-review'
import { AutoEditFilmstrip } from './AutoEditFilmstrip'

export type AutoEditSelection =
  | { kind: 'anchor'; key: AutoEditAnchorKey }
  | { kind: 'segment'; index: number }

interface AutoEditTimelineProps {
  items: readonly AutoEditLaneItem[]
  blocks: readonly AutoEditTimelineBlock[]
  cues: readonly AutoEditCue[]
  anchors: AutoEditAnchors
  sections: AutoEditSections
  durationSeconds: number
  totalSeconds: number
  mediaUrl: string
  portrait: boolean
  selection: AutoEditSelection
  activeItemIndex: number | null
  linkedItemIndexes: ReadonlySet<number>
  disabled: boolean
  editLaneRef: RefObject<HTMLDivElement | null>
  editPlayheadRef: RefObject<HTMLSpanElement | null>
  sourcePlayheadRef: RefObject<HTMLSpanElement | null>
  onSelectSegment: (index: number) => void
  onSelectAnchor: (key: AutoEditAnchorKey) => void
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
  onDragAnchor: (key: AutoEditAnchorKey, seconds: number) => void
  onSeekSource: (seconds: number) => void
}

const DRAG_THRESHOLD_PX = 3

function spanStyle(leftPercent: number, widthPercent?: number): CSSProperties {
  return widthPercent === undefined
    ? { left: `${leftPercent.toFixed(3)}%` }
    : { left: `${leftPercent.toFixed(3)}%`, width: `${Math.max(0, widthPercent).toFixed(3)}%` }
}

function laneFraction(lane: HTMLElement, clientX: number): number {
  const rect = lane.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

/* Pointer drag along a lane: past a few pixels of travel every move reports
   where the pointer is as a fraction of the lane, less the distance between
   the grab and the thing being dragged (at `originFraction`), and the click
   that ends the drag is swallowed so it does not also count as a pick. */
function useLaneDrag(onFraction: (fraction: number) => void, originFraction: number | null = null) {
  const dragRef = useRef<{ pointerId: number; startX: number; grabOffsetPx: number; moved: boolean; lane: HTMLElement } | null>(null)
  const swallowClickRef = useRef(false)
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      const lane = event.currentTarget.closest<HTMLElement>('[data-lane]')
      if (!lane) return
      const rect = lane.getBoundingClientRect()
      const grabOffsetPx = originFraction === null ? 0 : event.clientX - (rect.left + originFraction * rect.width)
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, grabOffsetPx, moved: false, lane }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      onFraction(laneFraction(drag.lane, event.clientX - drag.grabOffsetPx))
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      swallowClickRef.current = drag.moved
      dragRef.current = null
    },
    onPointerCancel: () => {
      dragRef.current = null
    },
    takeClick: () => {
      const swallow = swallowClickRef.current
      swallowClickRef.current = false
      return !swallow
    },
  }
}

function markerAlign(key: AutoEditAnchorKey, percent: number): 'before' | 'center' | 'after' {
  if (key === 'moment.peak') return percent < 4 ? 'after' : percent > 96 ? 'before' : 'center'
  if (key === 'hook.start' || key === 'moment.start') return percent < 8 ? 'after' : 'before'
  return percent > 92 ? 'before' : 'after'
}

function handleMarkerKey(
  event: KeyboardEvent<HTMLButtonElement>,
  key: AutoEditAnchorKey,
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void,
) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const step = event.shiftKey ? 10 : 1
  onNudgeAnchor(key, event.key === 'ArrowLeft' ? -step : step)
}

function LaneLabel({ name, value }: { name: string; value: string }) {
  return (
    <div className="auto-edit-lane-label">
      <span>{name}</span>
      <strong>{value}</strong>
    </div>
  )
}

function AnchorMarker({
  anchorKey,
  anchors,
  durationSeconds,
  selected,
  disabled,
  onSelectAnchor,
  onNudgeAnchor,
  onDragAnchor,
}: {
  anchorKey: AutoEditAnchorKey
  anchors: AutoEditAnchors
  durationSeconds: number
  selected: boolean
  disabled: boolean
  onSelectAnchor: (key: AutoEditAnchorKey) => void
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
  onDragAnchor: (key: AutoEditAnchorKey, seconds: number) => void
}) {
  const info = AUTO_EDIT_ANCHOR_INFO[anchorKey]
  const secondsValue = autoEditAnchorSeconds(anchors, anchorKey)
  const percent = autoEditSourcePercent(secondsValue, durationSeconds)
  const drag = useLaneDrag((fraction) => onDragAnchor(anchorKey, fraction * durationSeconds), percent / 100)
  return (
    <button
      type="button"
      className="auto-edit-marker"
      data-anchor={anchorKey}
      data-align={markerAlign(anchorKey, percent)}
      aria-pressed={selected}
      aria-label={`${info.label} ${secondsValue.toFixed(2)}s`}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
      title={`${info.label} ${secondsValue.toFixed(2)}s · drag to move, or ← → a frame`}
      disabled={disabled}
      style={spanStyle(percent)}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerCancel}
      onClick={() => {
        if (drag.takeClick()) onSelectAnchor(anchorKey)
      }}
      onKeyDown={(event) => handleMarkerKey(event, anchorKey, onNudgeAnchor)}
    >
      {info.short}
    </button>
  )
}

function EditLane({
  items,
  blocks,
  selection,
  linkedItemIndexes,
  editLaneRef,
  editPlayheadRef,
  onSelectSegment,
}: Pick<AutoEditTimelineProps, 'items' | 'blocks' | 'selection' | 'linkedItemIndexes' | 'editLaneRef' | 'editPlayheadRef' | 'onSelectSegment'>) {
  return (
    <div ref={editLaneRef} className="auto-edit-edit-lane" role="group" aria-label="Edit segments">
      {items.map((item, position) => {
        const block = blocks[position]
        if (!block) return null
        return (
          <button
            key={item.key}
            type="button"
            className="auto-edit-segment"
            data-tone={item.tone}
            data-linked={linkedItemIndexes.has(item.index) ? 'true' : undefined}
            aria-pressed={selection.kind === 'segment' && selection.index === item.index}
            aria-label={`${item.label} ${item.lengthText}`}
            title={`${item.label} · ${item.lengthText} · source ${item.sourceStartSeconds.toFixed(2)}–${item.sourceEndSeconds.toFixed(2)} s`}
            style={spanStyle(block.leftPercent, block.widthPercent)}
            onClick={() => onSelectSegment(item.index)}
          >
            <span className="auto-edit-segment-name">{item.label}</span>
            <span className="auto-edit-segment-length">{item.lengthText}</span>
            {item.ranges.slice(1).map((range) => (
              <span
                key={range.segment.id}
                className="auto-edit-segment-cut"
                aria-hidden="true"
                style={spanStyle(((range.outputStartSeconds - item.outputStartSeconds) / item.outputDurationSeconds) * 100)}
              />
            ))}
          </button>
        )
      })}
      <span ref={editPlayheadRef} className="auto-edit-playhead" aria-hidden="true" />
    </div>
  )
}

function SourceLane({
  items,
  anchors,
  sections,
  durationSeconds,
  mediaUrl,
  portrait,
  selection,
  activeItemIndex,
  sourcePlayheadRef,
  onSeekSource,
}: Pick<
  AutoEditTimelineProps,
  'items' | 'anchors' | 'sections' | 'durationSeconds' | 'mediaUrl' | 'portrait' | 'selection' | 'activeItemIndex' | 'sourcePlayheadRef' | 'onSeekSource'
>) {
  const drag = useLaneDrag((fraction) => onSeekSource(fraction * durationSeconds))
  const at = (value: number) => autoEditSourcePercent(value, durationSeconds)
  const active = activeItemIndex === null ? null : items.find((item) => item.index === activeItemIndex) ?? null
  const showHook = sections.coldOpen && anchors.hook !== null
  const lineKeys = showHook ? [...AUTO_EDIT_HOOK_ANCHORS, ...AUTO_EDIT_MOMENT_ANCHORS] : AUTO_EDIT_MOMENT_ANCHORS
  const seekFromClick = (event: MouseEvent<HTMLDivElement>) => {
    if (drag.takeClick()) onSeekSource(laneFraction(event.currentTarget, event.clientX) * durationSeconds)
  }
  return (
    <div
      className="auto-edit-source-lane"
      data-lane="source"
      aria-hidden="true"
      title="Click or drag to show the source here"
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerCancel}
      onClick={seekFromClick}
    >
      <AutoEditFilmstrip mediaUrl={mediaUrl} durationSeconds={durationSeconds} portrait={portrait} />
      <span className="auto-edit-source-shade" />
      {anchors.keep.start > 0 && <span className="auto-edit-source-trim" style={spanStyle(0, at(anchors.keep.start))} />}
      {anchors.keep.end < durationSeconds && (
        <span className="auto-edit-source-trim" style={spanStyle(at(anchors.keep.end), 100 - at(anchors.keep.end))} />
      )}
      {anchors.cuts.map((cut) => (
        <span key={`${cut.start}-${cut.end}`} className="auto-edit-source-cut" style={spanStyle(at(cut.start), at(cut.end) - at(cut.start))} />
      ))}
      <span
        className="auto-edit-source-moment"
        style={spanStyle(at(anchors.moment.start), at(anchors.moment.end) - at(anchors.moment.start))}
      />
      {showHook && (
        <span
          className="auto-edit-source-hook"
          style={spanStyle(at(anchors.hook!.start), at(anchors.hook!.end) - at(anchors.hook!.start))}
        />
      )}
      {active?.ranges.map((range) => (
        <span
          key={range.segment.id}
          className="auto-edit-source-active"
          data-tone={active.tone}
          style={spanStyle(at(range.sourceStartSeconds), at(range.sourceEndSeconds) - at(range.sourceStartSeconds))}
        />
      ))}
      {lineKeys.map((key) => (
        <span
          key={key}
          className="auto-edit-source-line"
          data-anchor={key}
          data-selected={selection.kind === 'anchor' && selection.key === key ? 'true' : undefined}
          style={spanStyle(at(autoEditAnchorSeconds(anchors, key)))}
        />
      ))}
      <span ref={sourcePlayheadRef} className="auto-edit-playhead auto-edit-playhead-source" />
    </div>
  )
}

export function AutoEditTimeline(props: AutoEditTimelineProps) {
  const {
    items,
    blocks,
    cues,
    anchors,
    sections,
    durationSeconds,
    totalSeconds,
    selection,
    activeItemIndex,
    disabled,
    onSelectAnchor,
    onNudgeAnchor,
    onDragAnchor,
  } = props
  const activePosition = activeItemIndex === null ? -1 : items.findIndex((item) => item.index === activeItemIndex)
  const activeItem = activePosition >= 0 ? items[activePosition] : undefined
  const activeBlock = activePosition >= 0 ? blocks[activePosition] : undefined
  const showHook = sections.coldOpen && anchors.hook !== null
  const markerProps = { anchors, durationSeconds, disabled, onSelectAnchor, onNudgeAnchor, onDragAnchor }
  const isSelected = (key: AutoEditAnchorKey) => selection.kind === 'anchor' && selection.key === key

  return (
    <section className="auto-edit-timeline" aria-label="Timeline">
      <div className="auto-edit-lane-row">
        <LaneLabel name="Edit" value={`${totalSeconds.toFixed(2)}s`} />
        <EditLane {...props} />
      </div>

      {cues.length > 0 && (
        <div className="auto-edit-lane-row">
          <span className="auto-edit-lane-caption">sounds</span>
          <div className="auto-edit-cue-lane" aria-hidden="true">
            {cues.map((cue, index) => (
              <span
                key={`${cue.sound}-${index}`}
                className="auto-edit-cue"
                title={autoEditSoundLabel(cue.sound)}
                style={spanStyle(autoEditEditPercentAt(items, blocks, cue.startSeconds))}
              />
            ))}
          </div>
        </div>
      )}

      <div className="auto-edit-lane-row" aria-hidden="true">
        <span />
        <div className="auto-edit-connector">
          {activeItem && activeBlock && (
            <span
              data-tone={activeItem.tone}
              style={{ clipPath: autoEditConnectorClip(activeBlock, activeItem, durationSeconds) }}
            />
          )}
        </div>
      </div>

      {showHook && (
        <div className="auto-edit-lane-row">
          <span className="auto-edit-lane-caption">hook</span>
          <div className="auto-edit-marker-lane" data-lane="hook" role="group" aria-label="Hook markers">
            {AUTO_EDIT_HOOK_ANCHORS.map((key) => (
              <AnchorMarker key={key} anchorKey={key} selected={isSelected(key)} {...markerProps} />
            ))}
          </div>
        </div>
      )}

      <div className="auto-edit-lane-row">
        <LaneLabel name="Source" value={`${durationSeconds.toFixed(2)}s`} />
        <SourceLane {...props} />
      </div>

      <div className="auto-edit-lane-row">
        <span className="auto-edit-lane-caption">moment</span>
        <div className="auto-edit-marker-lane" data-lane="moment" role="group" aria-label="Moment markers">
          {AUTO_EDIT_MOMENT_ANCHORS.map((key) => (
            <AnchorMarker key={key} anchorKey={key} selected={isSelected(key)} {...markerProps} />
          ))}
        </div>
      </div>

      <div className="auto-edit-lane-row" aria-hidden="true">
        <span />
        <div className="auto-edit-ruler">
          {autoEditTicks(durationSeconds).map((tick) => (
            <span key={tick.seconds} style={spanStyle(tick.percent)} data-edge={tick.percent === 0 ? 'start' : tick.percent >= 100 ? 'end' : undefined}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

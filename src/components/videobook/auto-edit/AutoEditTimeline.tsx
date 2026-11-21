import { useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { GripVertical, Scissors } from 'lucide-react'
import type { AutoEditAnchors, AutoEditCue, AutoEditSections } from '../../../../server/src/auto-edit/style'
import {
  AUTO_EDIT_ANCHOR_INFO,
  AUTO_EDIT_HOOK_ANCHORS,
  AUTO_EDIT_KEEP_ANCHORS,
  AUTO_EDIT_MOMENT_ANCHORS,
  autoEditAnchorSeconds,
  autoEditConnectorClip,
  autoEditCutsInItem,
  autoEditEditPercentAt,
  autoEditSoundLabel,
  autoEditSourcePercent,
  autoEditTicks,
  type AutoEditAnchorKey,
  type AutoEditLaneItem,
  type AutoEditTimelineBlock,
  type AutoEditTrimEdge,
} from '@/videobook/auto-edit-review'
import { AutoEditFilmstrip } from './AutoEditFilmstrip'
import { AutoEditTrimField } from './AutoEditTrimField'

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
  item: AutoEditLaneItem | undefined
  edges: readonly AutoEditTrimEdge[]
  fps: number
  selectedMarker: AutoEditAnchorKey | null
  disabled: boolean
  editLaneRef: RefObject<HTMLDivElement | null>
  editPlayheadRef: RefObject<HTMLSpanElement | null>
  sourcePlayheadRef: RefObject<HTMLSpanElement | null>
  onSelectSegment: (index: number) => void
  onSelectAnchor: (key: AutoEditAnchorKey) => void
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
  onDragAnchor: (key: AutoEditAnchorKey, seconds: number) => void
  onSeekSource: (seconds: number) => void
  onCloseMarkers: () => void
  onTrim: (edge: AutoEditTrimEdge, seconds: number) => void
  onInspectEdge: (edge: AutoEditTrimEdge) => void
  onSetEdgeToPlayhead: (edge: AutoEditTrimEdge) => void
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
  const dragRef = useRef<{ pointerId: number; startX: number; grabOffsetPx: number; moved: boolean; lane: HTMLElement; move: (fraction: number) => void } | null>(null)
  const swallowClickRef = useRef(false)
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary) return
      const lane = event.currentTarget.closest<HTMLElement>('[data-lane]')
      if (!lane) return
      const rect = lane.getBoundingClientRect()
      const grabOffsetPx = originFraction === null ? 0 : event.clientX - (rect.left + originFraction * rect.width)
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, grabOffsetPx, moved: false, lane, move: onFraction }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (!drag.moved && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      drag.move(laneFraction(drag.lane, event.clientX - drag.grabOffsetPx))
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
  if (key === 'keep.start' || key === 'hook.start' || key === 'moment.start') return percent < 8 ? 'after' : 'before'
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
  item: selectedItem,
  selectedMarker,
  disabled,
  editLaneRef,
  editPlayheadRef,
  onSelectSegment,
}: Pick<AutoEditTimelineProps, 'items' | 'blocks' | 'item' | 'selectedMarker' | 'disabled' | 'editLaneRef' | 'editPlayheadRef' | 'onSelectSegment'>) {
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
            data-linked={selectedMarker && (item.trim?.start === selectedMarker || item.trim?.end === selectedMarker) ? 'true' : undefined}
            disabled={disabled}
            aria-pressed={selectedItem?.key === item.key}
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

function TrimHandle({
  edge, label, durationSeconds, fps, disabled, onTrim, onInspectEdge,
}: Pick<AutoEditTimelineProps, 'durationSeconds' | 'fps' | 'disabled' | 'onTrim' | 'onInspectEdge'> & {
  edge: AutoEditTrimEdge
  label: string
}) {
  const percent = autoEditSourcePercent(edge.seconds, durationSeconds)
  const drag = useLaneDrag((fraction) => onTrim(edge, fraction * durationSeconds), percent / 100)
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = (event.shiftKey ? 10 : 1) / fps
    let next: number
    switch (event.key) {
      case 'Home': next = edge.min; break
      case 'End': next = edge.max; break
      case 'ArrowLeft': case 'ArrowDown': next = edge.seconds - step; break
      case 'ArrowRight': case 'ArrowUp': next = edge.seconds + step; break
      default: return
    }
    event.preventDefault()
    onTrim(edge, next)
  }
  return (
    <button
      type="button"
      role="slider"
      className="auto-edit-trim-handle"
      data-side={edge.side}
      style={{ '--trim-position': `${percent}%` } as CSSProperties}
      aria-label={`${label} ${edge.side}`}
      aria-valuemin={edge.min}
      aria-valuemax={edge.max}
      aria-valuenow={edge.seconds}
      aria-valuetext={`${edge.seconds.toFixed(2)} seconds, frame ${Math.round(edge.seconds * fps)}`}
      title={`Drag ${label} ${edge.side} · ← → one frame`}
      disabled={disabled}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      onPointerCancel={drag.onPointerCancel}
      onClick={() => { if (drag.takeClick()) onInspectEdge(edge) }}
      onKeyDown={onKeyDown}
    >
      <span><GripVertical size={13} aria-hidden="true" />{edge.side === 'start' ? 'Start' : 'End'}</span>
    </button>
  )
}

function SourceLane(props: Pick<
  AutoEditTimelineProps,
  'item' | 'edges' | 'anchors' | 'selectedMarker' | 'durationSeconds' | 'mediaUrl' | 'portrait' | 'sourcePlayheadRef' |
  'onSeekSource' | 'fps' | 'disabled' | 'onTrim' | 'onInspectEdge'
>) {
  const { item, edges, anchors, selectedMarker, durationSeconds, mediaUrl, portrait, sourcePlayheadRef, onSeekSource } = props
  const drag = useLaneDrag((fraction) => onSeekSource(fraction * durationSeconds))
  const at = (value: number) => autoEditSourcePercent(value, durationSeconds)
  const start = at(item?.sourceStartSeconds ?? 0)
  const end = at(item?.sourceEndSeconds ?? durationSeconds)
  const seekFromClick = (event: MouseEvent<HTMLDivElement>) => {
    if (drag.takeClick()) onSeekSource(laneFraction(event.currentTarget, event.clientX) * durationSeconds)
  }
  return (
    <div className="auto-edit-source-lane" data-lane="source">
      <div
        className="auto-edit-source-scrub"
        title="Click or drag to preview a source frame"
        aria-hidden="true"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
        onClick={seekFromClick}
      >
        <AutoEditFilmstrip mediaUrl={mediaUrl} durationSeconds={durationSeconds} portrait={portrait} />
        <span className="auto-edit-source-trim" style={spanStyle(0, start)} />
        <span className="auto-edit-source-trim" style={spanStyle(end, 100 - end)} />
        {item && autoEditCutsInItem(item, anchors).map((index) => {
          const cut = anchors.cuts[index]!
          return <span key={cut.start} className="auto-edit-source-cut" style={spanStyle(at(cut.start), at(cut.end) - at(cut.start))} />
        })}
        <span className="auto-edit-trim-outline" style={spanStyle(start, end - start)} />
        {selectedMarker && (
          <span className="auto-edit-source-line" style={spanStyle(at(autoEditAnchorSeconds(anchors, selectedMarker)))} />
        )}
        <span ref={sourcePlayheadRef} className="auto-edit-playhead auto-edit-playhead-source" />
      </div>
      {item && edges.map((edge) => <TrimHandle key={`${item.key}-${edge.key}`} {...props} edge={edge} label={item.label} />)}
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
    item,
    edges,
    selectedMarker,
    disabled,
    onSelectAnchor,
    onNudgeAnchor,
    onDragAnchor,
  } = props
  const block = blocks.find((entry) => entry.index === item?.index)
  const showHook = sections.coldOpen && anchors.hook !== null
  const markerProps = { anchors, durationSeconds, disabled, onSelectAnchor, onNudgeAnchor, onDragAnchor }
  const isSelected = (key: AutoEditAnchorKey) => selectedMarker === key

  return (
    <section className="auto-edit-timeline" aria-label="Timeline">
      <div className="auto-edit-output-scroll">
        <div className="auto-edit-output-tracks">
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
        </div>
      </div>

      <div className="auto-edit-lane-row" aria-hidden="true">
        <span />
        <div className="auto-edit-connector">
          {item && block && (
            <span
              data-tone={item.tone}
              style={{ clipPath: autoEditConnectorClip(block, item, durationSeconds) }}
            />
          )}
        </div>
      </div>

      <div className="auto-edit-lane-row">
        <LaneLabel name="Source" value={`${durationSeconds.toFixed(2)}s`} />
        <SourceLane {...props} />
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
      {item && edges.length > 0 && (
        <div className="auto-edit-trim-controls" role="group" aria-label={`Trim ${item.label}`}>
          <div className="auto-edit-trim-heading">
            <h3><Scissors size={14} aria-hidden="true" /> Trim {item.label}</h3>
            <span>Drag a handle or enter a source time.</span>
          </div>
          {edges.map((edge) => (
            <AutoEditTrimField
              key={`${item.key}-${edge.key}`}
              edge={edge}
              clip={item.label}
              fps={props.fps}
              disabled={disabled}
              onTrim={props.onTrim}
              onSetToPlayhead={props.onSetEdgeToPlayhead}
            />
          ))}
        </div>
      )}
      <details className="auto-edit-all-markers" onToggle={(event) => {
        if (!event.currentTarget.open) props.onCloseMarkers()
      }}>
        <summary>All timing markers</summary>
        <div className="auto-edit-lane-row">
          <span className="auto-edit-lane-caption">body</span>
          <div className="auto-edit-marker-lane" data-lane="body" role="group" aria-label="Body markers">
            {AUTO_EDIT_KEEP_ANCHORS.map((key) => (
              <AnchorMarker key={key} anchorKey={key} selected={isSelected(key)} {...markerProps} />
            ))}
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
          <span className="auto-edit-lane-caption">moment</span>
          <div className="auto-edit-marker-lane" data-lane="moment" role="group" aria-label="Moment markers">
            {AUTO_EDIT_MOMENT_ANCHORS.map((key) => (
              <AnchorMarker key={key} anchorKey={key} selected={isSelected(key)} {...markerProps} />
            ))}
          </div>
        </div>
      </details>
    </section>
  )
}

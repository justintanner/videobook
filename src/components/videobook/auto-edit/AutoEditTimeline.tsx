import type { CSSProperties, KeyboardEvent, MouseEvent, RefObject } from 'react'
import type { AutoEditAnchors, AutoEditCue, AutoEditSections } from '../../../../server/src/auto-edit/style'
import type { AutoEditSegmentRange } from '@/videobook/auto-edit-preview'
import {
  AUTO_EDIT_ANCHOR_INFO,
  AUTO_EDIT_HOOK_ANCHORS,
  AUTO_EDIT_MOMENT_ANCHORS,
  autoEditAnchorSeconds,
  autoEditConnectorClip,
  autoEditEditPercentAt,
  autoEditSegmentLengthText,
  autoEditSegmentTone,
  autoEditSoundLabel,
  autoEditSourcePercent,
  autoEditTicks,
  type AutoEditAnchorKey,
  type AutoEditTimelineBlock,
} from '@/videobook/auto-edit-review'
import { AutoEditFilmstrip } from './AutoEditFilmstrip'

export type AutoEditSelection =
  | { kind: 'anchor'; key: AutoEditAnchorKey }
  | { kind: 'segment'; index: number }

interface AutoEditTimelineProps {
  ranges: readonly AutoEditSegmentRange[]
  blocks: readonly AutoEditTimelineBlock[]
  cues: readonly AutoEditCue[]
  anchors: AutoEditAnchors
  sections: AutoEditSections
  durationSeconds: number
  totalSeconds: number
  mediaUrl: string
  portrait: boolean
  selection: AutoEditSelection
  activeSegmentIndex: number | null
  linkedSegmentIndexes: ReadonlySet<number>
  disabled: boolean
  editLaneRef: RefObject<HTMLDivElement | null>
  editPlayheadRef: RefObject<HTMLSpanElement | null>
  sourcePlayheadRef: RefObject<HTMLSpanElement | null>
  onSelectSegment: (index: number) => void
  onSelectAnchor: (key: AutoEditAnchorKey) => void
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
  onSeekSource: (seconds: number) => void
}

function spanStyle(leftPercent: number, widthPercent?: number): CSSProperties {
  return widthPercent === undefined
    ? { left: `${leftPercent.toFixed(3)}%` }
    : { left: `${leftPercent.toFixed(3)}%`, width: `${Math.max(0, widthPercent).toFixed(3)}%` }
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
}: {
  anchorKey: AutoEditAnchorKey
  anchors: AutoEditAnchors
  durationSeconds: number
  selected: boolean
  disabled: boolean
  onSelectAnchor: (key: AutoEditAnchorKey) => void
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
}) {
  const info = AUTO_EDIT_ANCHOR_INFO[anchorKey]
  const secondsValue = autoEditAnchorSeconds(anchors, anchorKey)
  const percent = autoEditSourcePercent(secondsValue, durationSeconds)
  return (
    <button
      type="button"
      className="auto-edit-marker"
      data-anchor={anchorKey}
      data-align={markerAlign(anchorKey, percent)}
      aria-pressed={selected}
      aria-label={`${info.label} ${secondsValue.toFixed(2)}s`}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
      disabled={disabled}
      style={spanStyle(percent)}
      onClick={() => onSelectAnchor(anchorKey)}
      onKeyDown={(event) => handleMarkerKey(event, anchorKey, onNudgeAnchor)}
    >
      {info.short}
    </button>
  )
}

function EditLane({
  ranges,
  blocks,
  selection,
  linkedSegmentIndexes,
  editLaneRef,
  editPlayheadRef,
  onSelectSegment,
}: Pick<AutoEditTimelineProps, 'ranges' | 'blocks' | 'selection' | 'linkedSegmentIndexes' | 'editLaneRef' | 'editPlayheadRef' | 'onSelectSegment'>) {
  return (
    <div ref={editLaneRef} className="auto-edit-edit-lane" role="group" aria-label="Edit segments">
      {ranges.map((range, position) => {
        const block = blocks[position]
        if (!block) return null
        const lengthText = autoEditSegmentLengthText(range)
        return (
          <button
            key={range.segment.id}
            type="button"
            className="auto-edit-segment"
            data-segment-id={range.segment.id}
            data-tone={autoEditSegmentTone(range)}
            data-linked={linkedSegmentIndexes.has(range.index) ? 'true' : undefined}
            aria-pressed={selection.kind === 'segment' && selection.index === range.index}
            aria-label={`${range.label} ${lengthText}`}
            title={`${range.label} · ${lengthText} · source ${range.sourceStartSeconds.toFixed(2)}–${range.sourceEndSeconds.toFixed(2)} s`}
            style={spanStyle(block.leftPercent, block.widthPercent)}
            onClick={() => onSelectSegment(range.index)}
          >
            <span className="auto-edit-segment-name">{range.label}</span>
            <span className="auto-edit-segment-length">{lengthText}</span>
          </button>
        )
      })}
      <span ref={editPlayheadRef} className="auto-edit-playhead" aria-hidden="true" />
    </div>
  )
}

function SourceLane({
  ranges,
  anchors,
  sections,
  durationSeconds,
  mediaUrl,
  portrait,
  selection,
  activeSegmentIndex,
  sourcePlayheadRef,
  onSeekSource,
}: Pick<
  AutoEditTimelineProps,
  'ranges' | 'anchors' | 'sections' | 'durationSeconds' | 'mediaUrl' | 'portrait' | 'selection' | 'activeSegmentIndex' | 'sourcePlayheadRef' | 'onSeekSource'
>) {
  const at = (value: number) => autoEditSourcePercent(value, durationSeconds)
  const active = activeSegmentIndex === null ? null : ranges.find((range) => range.index === activeSegmentIndex) ?? null
  const showHook = sections.coldOpen && anchors.hook !== null
  const lineKeys = showHook ? [...AUTO_EDIT_HOOK_ANCHORS, ...AUTO_EDIT_MOMENT_ANCHORS] : AUTO_EDIT_MOMENT_ANCHORS
  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    onSeekSource(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * durationSeconds)
  }
  return (
    <div className="auto-edit-source-lane" aria-hidden="true" title="Click to show this moment of the source" onClick={seekFromPointer}>
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
      {active && (
        <span
          className="auto-edit-source-active"
          data-tone={autoEditSegmentTone(active)}
          style={spanStyle(at(active.sourceStartSeconds), at(active.sourceEndSeconds) - at(active.sourceStartSeconds))}
        />
      )}
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
    ranges,
    blocks,
    cues,
    anchors,
    sections,
    durationSeconds,
    totalSeconds,
    selection,
    activeSegmentIndex,
    disabled,
    onSelectAnchor,
    onNudgeAnchor,
  } = props
  const activePosition = activeSegmentIndex === null ? -1 : ranges.findIndex((range) => range.index === activeSegmentIndex)
  const activeRange = activePosition >= 0 ? ranges[activePosition] : undefined
  const activeBlock = activePosition >= 0 ? blocks[activePosition] : undefined
  const showHook = sections.coldOpen && anchors.hook !== null
  const markerProps = { anchors, durationSeconds, disabled, onSelectAnchor, onNudgeAnchor }
  const isSelected = (key: AutoEditAnchorKey) => selection.kind === 'anchor' && selection.key === key

  return (
    <section className="auto-edit-timeline" aria-label="Timeline">
      <div className="auto-edit-lane-row">
        <LaneLabel name="Edit" value={`${totalSeconds.toFixed(2)}s`} />
        <EditLane {...props} />
      </div>

      {cues.length > 0 && (
        <div className="auto-edit-lane-row auto-edit-lane-row-thin">
          <span className="auto-edit-lane-caption">sounds</span>
          <div className="auto-edit-cue-lane" aria-hidden="true">
            {cues.map((cue, index) => (
              <span
                key={`${cue.sound}-${index}`}
                className="auto-edit-cue"
                title={autoEditSoundLabel(cue.sound)}
                style={spanStyle(autoEditEditPercentAt(ranges, blocks, cue.startSeconds))}
              />
            ))}
          </div>
        </div>
      )}

      <div className="auto-edit-lane-row auto-edit-lane-row-connector" aria-hidden="true">
        <span />
        <div className="auto-edit-connector">
          {activeRange && activeBlock && (
            <span
              data-tone={autoEditSegmentTone(activeRange)}
              style={{ clipPath: autoEditConnectorClip(activeBlock, activeRange, durationSeconds) }}
            />
          )}
        </div>
      </div>

      {showHook && (
        <div className="auto-edit-lane-row">
          <span className="auto-edit-lane-caption">hook</span>
          <div className="auto-edit-marker-lane" role="group" aria-label="Hook markers">
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
        <div className="auto-edit-marker-lane" role="group" aria-label="Moment markers">
          {AUTO_EDIT_MOMENT_ANCHORS.map((key) => (
            <AnchorMarker key={key} anchorKey={key} selected={isSelected(key)} {...markerProps} />
          ))}
        </div>
      </div>

      <div className="auto-edit-lane-row auto-edit-lane-row-thin" aria-hidden="true">
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

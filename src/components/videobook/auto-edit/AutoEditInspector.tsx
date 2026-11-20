import { secondsToFrame } from '../../../../server/src/auto-edit/plan'
import type { AutoEditAnchors } from '../../../../server/src/auto-edit/style'
import type { AutoEditSegmentRange } from '@/videobook/auto-edit-preview'
import {
  AUTO_EDIT_ANCHOR_INFO,
  autoEditAnchorRule,
  autoEditAnchorSeconds,
  autoEditAnchorsForSegment,
  autoEditSegmentFacts,
  autoEditSegmentTone,
  autoEditSegmentsForAnchor,
  type AutoEditAnchorKey,
} from '@/videobook/auto-edit-review'
import type { AutoEditSelection } from './AutoEditTimeline'

interface AutoEditInspectorProps {
  selection: AutoEditSelection
  anchors: AutoEditAnchors
  ranges: readonly AutoEditSegmentRange[]
  fps: number
  changes: readonly string[]
  disabled: boolean
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
  onSetToPlayhead: (key: AutoEditAnchorKey) => void
  onSelectAnchor: (key: AutoEditAnchorKey) => void
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function AnchorDetails({
  anchorKey,
  anchors,
  ranges,
  fps,
  disabled,
  onNudgeAnchor,
  onSetToPlayhead,
}: Omit<AutoEditInspectorProps, 'selection' | 'changes' | 'onSelectAnchor'> & { anchorKey: AutoEditAnchorKey }) {
  const info = AUTO_EDIT_ANCHOR_INFO[anchorKey]
  const secs = autoEditAnchorSeconds(anchors, anchorKey)
  const moves = [...new Set(autoEditSegmentsForAnchor(ranges, anchors, anchorKey, fps).map((range) => range.label))]
  const focus = info.focus ? anchors.focus[info.focus] : null
  return (
    <div className="auto-edit-inspector-body" role="group" aria-label={info.label}>
      <div className="auto-edit-inspector-head">
        <span className="auto-edit-inspector-swatch" data-anchor={anchorKey} aria-hidden="true" />
        <strong>{info.label}</strong>
        <span className="auto-edit-inspector-time">{`${secs.toFixed(2)}s · frame ${secondsToFrame(secs, fps)}`}</span>
      </div>
      <div className="auto-edit-inspector-actions">
        <button type="button" disabled={disabled} onClick={() => onNudgeAnchor(anchorKey, -1)}>-1 frame</button>
        <button type="button" disabled={disabled} onClick={() => onNudgeAnchor(anchorKey, 1)}>+1 frame</button>
        <button type="button" className="auto-edit-to-playhead" disabled={disabled} onClick={() => onSetToPlayhead(anchorKey)}>
          Move to playhead
        </button>
      </div>
      <p className="auto-edit-muted">
        {`${autoEditAnchorRule(anchorKey)} Moves ${moves.length > 0 ? moves.join(', ') : 'nothing while its beats are off'}. On the timeline, ← and → move it a frame; Shift moves ten.`}
      </p>
      {focus && (
        <p className="auto-edit-subject">
          <span className="auto-edit-subject-chip">subject</span>
          {` ${percent(focus.x)} across, ${percent(focus.y)} down. Click the paused picture to move it.`}
        </p>
      )}
    </div>
  )
}

function SegmentDetails({
  range,
  anchors,
  fps,
  disabled,
  onSelectAnchor,
}: {
  range: AutoEditSegmentRange
  anchors: AutoEditAnchors
  fps: number
  disabled: boolean
  onSelectAnchor: (key: AutoEditAnchorKey) => void
}) {
  const setBy = autoEditAnchorsForSegment(range.segment, anchors, fps)
  return (
    <div className="auto-edit-inspector-body" role="group" aria-label={`${range.label} segment`}>
      <div className="auto-edit-inspector-head">
        <span className="auto-edit-inspector-swatch" data-tone={autoEditSegmentTone(range)} aria-hidden="true" />
        <strong>{range.label}</strong>
        <span className="auto-edit-inspector-time">{`${range.outputDurationSeconds.toFixed(2)}s`}</span>
      </div>
      <dl className="auto-edit-facts">
        <dt>Edit</dt>
        <dd>{`${range.outputStartSeconds.toFixed(2)}–${range.outputEndSeconds.toFixed(2)} s`}</dd>
        <dt>Source</dt>
        <dd>{`${range.sourceStartSeconds.toFixed(2)}–${range.sourceEndSeconds.toFixed(2)} s`}</dd>
        <dt>Treatment</dt>
        <dd>{autoEditSegmentFacts(range.segment)}</dd>
      </dl>
      {setBy.length > 0 && (
        <div className="auto-edit-inspector-actions">
          <span className="auto-edit-muted">Set by</span>
          {setBy.map((key) => (
            <button key={key} type="button" disabled={disabled} onClick={() => onSelectAnchor(key)}>
              {`${AUTO_EDIT_ANCHOR_INFO[key].label} ${autoEditAnchorSeconds(anchors, key).toFixed(2)}s`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function AutoEditInspector(props: AutoEditInspectorProps) {
  const { selection, ranges, changes } = props
  const range = selection.kind === 'segment' ? ranges.find((entry) => entry.index === selection.index) : undefined
  return (
    <section className="auto-edit-panel auto-edit-inspector" aria-label="Selected">
      <h3 className="auto-edit-panel-title">Selected</h3>
      {selection.kind === 'anchor' && <AnchorDetails {...props} anchorKey={selection.key} />}
      {range && <SegmentDetails range={range} {...props} />}
      {selection.kind === 'segment' && !range && (
        <p className="auto-edit-muted">Pick a segment or a marker on the timeline.</p>
      )}
      {changes.length > 0 && (
        <ul className="auto-edit-notices" role="status" aria-label="Anchor notices">
          {changes.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

import { secondsToFrame } from '../../../../server/src/auto-edit/plan'
import type { AutoEditAnchors } from '../../../../server/src/auto-edit/style'
import {
  AUTO_EDIT_ANCHOR_INFO,
  autoEditAnchorRule,
  autoEditAnchorSeconds,
  autoEditCutsInItem,
  autoEditItemsForAnchor,
  autoEditSegmentFacts,
  type AutoEditAnchorKey,
  type AutoEditLaneItem,
} from '@/videobook/auto-edit-review'

interface AutoEditInspectorProps {
  selectedMarker: AutoEditAnchorKey | null
  item?: AutoEditLaneItem
  anchors: AutoEditAnchors
  items: readonly AutoEditLaneItem[]
  fps: number
  changes: readonly string[]
  disabled: boolean
  onNudgeAnchor: (key: AutoEditAnchorKey, deltaFrames: number) => void
  onSetToPlayhead: (key: AutoEditAnchorKey) => void
  onRemoveCut: (cutIndex: number) => void
}

type AnchorControlsProps = Pick<AutoEditInspectorProps, 'disabled' | 'onNudgeAnchor' | 'onSetToPlayhead'> & {
  anchorKey: AutoEditAnchorKey
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function range(start: number, end: number): string {
  return `${start.toFixed(2)}–${end.toFixed(2)} s`
}

function AnchorControls({ anchorKey, disabled, onNudgeAnchor, onSetToPlayhead }: AnchorControlsProps) {
  return (
    <span className="auto-edit-anchor-controls">
      <button type="button" disabled={disabled} onClick={() => onNudgeAnchor(anchorKey, -1)}>-1 frame</button>
      <button type="button" disabled={disabled} onClick={() => onNudgeAnchor(anchorKey, 1)}>+1 frame</button>
      <button type="button" className="auto-edit-to-playhead" disabled={disabled} onClick={() => onSetToPlayhead(anchorKey)}>
        Move to playhead
      </button>
    </span>
  )
}

function AnchorDetails(props: Omit<AutoEditInspectorProps, 'selectedMarker' | 'changes' | 'item' | 'onRemoveCut'> & { anchorKey: AutoEditAnchorKey }) {
  const { anchorKey, anchors, items, fps } = props
  const info = AUTO_EDIT_ANCHOR_INFO[anchorKey]
  const secs = autoEditAnchorSeconds(anchors, anchorKey)
  const moves = [...new Set(autoEditItemsForAnchor(items, anchorKey).map((item) => item.label))]
  const focus = info.focus ? anchors.focus[info.focus] : null
  return (
    <div className="auto-edit-inspector-body" role="group" aria-label={info.label}>
      <div className="auto-edit-inspector-head">
        <span className="auto-edit-inspector-swatch" data-anchor={anchorKey} aria-hidden="true" />
        <strong>{info.label}</strong>
        <span className="auto-edit-inspector-time">{`${secs.toFixed(2)}s · frame ${secondsToFrame(secs, fps)}`}</span>
      </div>
      <AnchorControls {...props} />
      <p className="auto-edit-muted">
        {`Drag it on the timeline or use ← →. ${autoEditAnchorRule(anchorKey)} Moves ${moves.length > 0 ? moves.join(', ') : 'nothing while its beats are off'}.`}
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

function SegmentDetails(props: Pick<AutoEditInspectorProps, 'anchors' | 'disabled' | 'onRemoveCut'> & { item: AutoEditLaneItem }) {
  const { item, anchors, disabled, onRemoveCut } = props
  const cutIndexes = autoEditCutsInItem(item, anchors)
  const sourceText = cutIndexes.length > 0
    ? `${range(item.sourceStartSeconds, item.sourceEndSeconds)}, skipping ${cutIndexes.length} ${cutIndexes.length === 1 ? 'cut' : 'cuts'}`
    : range(item.sourceStartSeconds, item.sourceEndSeconds)
  return (
    <div className="auto-edit-inspector-body" role="group" aria-label={`${item.label} segment`}>
      <div className="auto-edit-inspector-head">
        <span className="auto-edit-inspector-swatch" data-tone={item.tone} aria-hidden="true" />
        <strong>{item.label}</strong>
        <span className="auto-edit-inspector-time">{item.lengthText}</span>
      </div>
      <dl className="auto-edit-facts">
        <dt>Edit</dt>
        <dd>{range(item.outputStartSeconds, item.outputEndSeconds)}</dd>
        <dt>Source</dt>
        <dd>{sourceText}</dd>
        <dt>Treatment</dt>
        <dd>{autoEditSegmentFacts(item.ranges[0]!.segment)}</dd>
      </dl>
      {cutIndexes.map((cutIndex) => {
        const cut = anchors.cuts[cutIndex]!
        return (
          <div key={`${cut.start}-${cut.end}`} className="auto-edit-anchor-row" role="group" aria-label={`Cut ${range(cut.start, cut.end)}`}>
            <span className="auto-edit-cut-name">{`Cut ${range(cut.start, cut.end)}`}</span>
            <button type="button" disabled={disabled} onClick={() => onRemoveCut(cutIndex)}>Keep this part</button>
          </div>
        )
      })}
      {cutIndexes.length > 0 && (
        <p className="auto-edit-muted">The edit jumps over each cut. Keep a part to put it back.</p>
      )}
    </div>
  )
}

export function AutoEditInspector(props: AutoEditInspectorProps) {
  const { selectedMarker, item, changes } = props
  return (
    <section className="auto-edit-panel auto-edit-inspector" aria-label="Selected">
      <h3 className="auto-edit-panel-title">Selected</h3>
      {selectedMarker && <AnchorDetails {...props} anchorKey={selectedMarker} />}
      {!selectedMarker && item && <SegmentDetails {...props} item={item} />}
      {!selectedMarker && !item && (
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

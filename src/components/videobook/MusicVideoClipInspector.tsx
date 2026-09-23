import { ChevronLeft, ChevronRight, Maximize2, Scissors, Trash2 } from 'lucide-react'
import type { SequenceClip } from 'videobook-engine'
import { formatTimecode } from '@/videobook/timecode'
import { SegmentedControl, TimecodeField, type SegmentedOption } from './MusicVideoPanels'

export type ClipFit = 'fit' | 'fill' | 'crop'

const FIT_OPTIONS: readonly SegmentedOption<ClipFit>[] = [
  { value: 'fit', label: 'Fit', title: 'Show the full frame' },
  { value: 'fill', label: 'Fill', title: 'Fill the frame, cropping edges' },
  { value: 'crop', label: 'Crop', title: 'Use the clip crop' },
]

export type ClipInspectorProps = {
  clip: SequenceClip
  label: string
  thumbnailUrl: string | null
  index: number
  count: number
  fps: number
  trimStart: number
  trimEnd: number
  trimMin: number
  trimMax: number
  speed: string
  speedOptions: readonly SegmentedOption<string>[]
  retimable: boolean
  busy: boolean
  editsDisabled: boolean
  canMoveEarlier: boolean
  canMoveLater: boolean
  canStretch: boolean
  onTrim: (edge: 'start' | 'end', startFrame: number, endFrame: number) => void
  onSpeed: (value: string) => void
  onFit: (fit: ClipFit) => void
  onSplit: () => void
  onStretch: () => void
  onMove: (offset: -1 | 1) => void
  onDelete: () => void
}

export function MusicVideoClipInspector(props: ClipInspectorProps) {
  const { clip, fps, trimStart, trimEnd, busy, editsDisabled } = props
  return (
    <div className="mv-clip-inspector">
      <header>
        {props.thumbnailUrl ? <img src={props.thumbnailUrl} alt="" /> : <span className="mv-clip-swatch" />}
        <div>
          <strong title={props.label}>{props.label}</strong>
          <small>Clip {props.index} of {props.count} · {formatTimecode(trimEnd - trimStart, fps)}</small>
        </div>
      </header>
      <div className="mv-clip-body">
        <div className="mv-field-pair">
          <TimecodeField key={`in-${clip.clipId}-${trimStart}`} label="In point" frame={trimStart} fps={fps} min={props.trimMin} max={trimEnd - 1} disabled={busy} onCommit={(frame) => props.onTrim('start', frame, trimEnd)} />
          <TimecodeField key={`out-${clip.clipId}-${trimEnd}`} label="Out point" frame={trimEnd} fps={fps} min={trimStart + 1} max={props.trimMax} disabled={busy} onCommit={(frame) => props.onTrim('end', trimStart, frame)} />
        </div>
        <p className="mv-hint">Or drag the clip edges on the timeline. I and O set them at the playhead.</p>
        <div className="mv-control">
          <span>Speed</span>
          <SegmentedControl label="Clip speed" options={props.speedOptions} value={props.speed} disabled={busy || !props.retimable} stretch onChange={props.onSpeed} />
        </div>
        <div className="mv-control">
          <span>Frame</span>
          <SegmentedControl label="Clip frame fit" options={FIT_OPTIONS} value={clip.transform?.fit ?? 'fit'} disabled={editsDisabled} stretch onChange={props.onFit} />
        </div>
      </div>
      <footer className="mv-clip-actions">
        <button type="button" disabled={busy} onClick={props.onSplit}><Scissors size={15} /> Split at playhead</button>
        <button type="button" disabled={editsDisabled || !props.canStretch} title="Extend to the next clip or the end" onClick={props.onStretch}><Maximize2 size={15} /> Fill to next</button>
        <button type="button" aria-label="Move earlier" disabled={editsDisabled || !props.canMoveEarlier} onClick={() => props.onMove(-1)}><ChevronLeft size={15} /> Earlier</button>
        <button type="button" aria-label="Move later" disabled={editsDisabled || !props.canMoveLater} onClick={() => props.onMove(1)}>Later <ChevronRight size={15} /></button>
        <button type="button" className="danger-button wide" disabled={editsDisabled} onClick={props.onDelete}><Trash2 size={15} /> Delete clip</button>
      </footer>
    </div>
  )
}

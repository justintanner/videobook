import { useState } from 'react'
import type { MusicDraftOptions, MusicVideoDraft } from '../../../server/src/rhythm/draft-model'

interface Props {
  sources: Array<{ artifactId: string; label: string }>
  trackId: string | null
  startFrame: number
  endFrame: number
  fps: number
  hasBars: boolean
  busy: boolean
  draft: MusicVideoDraft | null
  onPlan: (options: MusicDraftOptions) => void
  onOrder: (ids: string[]) => void
}

export function MusicDraftControls({ sources, trackId, startFrame, endFrame, fps, hasBars, busy, draft, onPlan, onOrder }: Props) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [interval, setInterval] = useState<1 | 2 | 4 | 8>(4)
  const [unit, setUnit] = useState<'beats' | 'bars'>('beats')
  const [minimum, setMinimum] = useState('0.25')
  const [preserve, setPreserve] = useState(true)
  const [reuse, setReuse] = useState(false)
  const [retime, setRetime] = useState(false)
  function move(index: number, direction: number) {
    const ids = sources.map((source) => source.artifactId)
    const target = index + direction
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    onOrder(ids)
  }
  return <section className="music-draft-controls" aria-label="Auto-cut to music">
    <p>Cut the selected footage to the music. You review the draft before anything changes.</p>
    <form onSubmit={(event) => {
      event.preventDefault()
      if (!trackId) return
      onPlan({ track_id: trackId, start_frame: Math.round(Number(start || startFrame / fps) * fps), end_frame: Math.round(Number(end || endFrame / fps) * fps),
        sources: sources.map((source) => ({ artifact_id: source.artifactId })), interval, unit,
        minimum_shot_frames: Math.max(1, Math.round(Number(minimum) * fps)), preserve_existing: preserve,
        preserve_clip_ids: [], reuse_sources: reuse, allow_retiming: retime, strategy: 'beat_interval' })
    }}>
      <div className="music-rhythm-row">
        <label>From (s)<input aria-label="Draft start seconds" type="number" min="0" step="any" placeholder={(startFrame / fps).toFixed(2)} value={start} onChange={(event) => setStart(event.target.value)} /></label>
        <label>To (s)<input aria-label="Draft end seconds" type="number" min="0" step="any" placeholder={(endFrame / fps).toFixed(2)} value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        <label>Cut every<select aria-label="Draft cut interval" value={interval} onChange={(event) => setInterval(Number(event.target.value) as typeof interval)}>{[1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <select aria-label="Draft interval unit" value={unit} onChange={(event) => setUnit(event.target.value as typeof unit)}><option value="beats">beats</option><option value="bars" disabled={!hasBars}>bars</option></select>
        <label>Minimum shot (s)<input aria-label="Minimum shot seconds" type="number" min="0.04" step="0.01" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></label>
        <label><input type="checkbox" checked={preserve} onChange={(event) => setPreserve(event.target.checked)} />Keep existing clips</label>
        <label><input type="checkbox" checked={reuse} onChange={(event) => setReuse(event.target.checked)} />Allow repeated footage</label>
        <label><input type="checkbox" checked={retime} onChange={(event) => setRetime(event.target.checked)} />Allow speed changes</label>
        <button type="submit" disabled={busy || !trackId || sources.length === 0}>Preview draft</button>
      </div>
      <ol className="music-draft-order" aria-label="Draft source order">{sources.map((source, index) => <li key={source.artifactId}>
        <b>{index + 1}</b><span>{source.label}</span><button type="button" aria-label={`Move ${source.label} earlier`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button><button type="button" aria-label={`Move ${source.label} later`} disabled={busy || index === sources.length - 1} onClick={() => move(index, 1)}>↓</button>
      </li>)}</ol>
      {!sources.length && <p>Select footage in Media, in the order you want it to appear.</p>}
    </form>
    {draft && <div className="music-draft-review" aria-label="Draft review">
      <strong>{draft.plan.summary} · {draft.preview.diff.removedClipIds.length} clips replaced</strong>
      {draft.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      {draft.uncovered.map((range) => <p key={range.startFrame}>Uncovered: {(range.startFrame / fps).toFixed(2)}–{(range.endFrame / fps).toFixed(2)}s</p>)}
      <table><thead><tr><th>Shot</th><th>Timeline</th><th>Source range</th><th>Speed</th></tr></thead><tbody>
        {draft.shots.map((shot, index) => <tr key={shot.clipId}><td>{index + 1} · {sources.find((source) => source.artifactId === shot.artifactId)?.label ?? 'Source'}</td><td>{(shot.startFrame / fps).toFixed(2)}–{(shot.endFrame / fps).toFixed(2)}s</td><td>{shot.sourceStartSeconds.toFixed(2)}–{shot.sourceEndSeconds.toFixed(2)}s</td><td>{shot.speed.toFixed(2)}×</td></tr>)}
      </tbody></table>
    </div>}
  </section>
}

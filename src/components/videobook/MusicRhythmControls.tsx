import { useRef, useState } from 'react'
import type { Sequence } from 'videobook-engine'
import type { useMusicRhythm } from '@/videobook/useMusicRhythm'
import { groupBeatBars, sourceTimeAtFrame } from '../../../server/src/rhythm/timing'
import type { RhythmMarker } from '../../../server/src/rhythm/model'

interface Props {
  rhythm: ReturnType<typeof useMusicRhythm>
  sequence: Sequence
  assets: readonly { artifactId: string; label: string }[]
  frame: number
  correctionsOpen: boolean
  onCorrectionsOpenChange: (open: boolean) => void
}

export function MusicRhythmControls({ rhythm, sequence, assets, frame, correctionsOpen, onCorrectionsOpenChange }: Props) {
  const taps = useRef<number[]>([])
  const [tempo, setTempo] = useState('')
  const [meter, setMeter] = useState('')
  const [message, setMessage] = useState('')
  const master = rhythm.master
  const pending = rhythm.status === 'queued' || rhythm.status === 'analyzing'
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator
  const audioTracks = new Set(sequence.tracks.filter((track) => track.kind === 'audio').map((track) => track.trackId))
  const clips = sequence.clips.filter((clip) => audioTracks.has(clip.trackId))
  const nearest = rhythm.mapped.reduce<(typeof rhythm.mapped)[number] | null>((best, marker) =>
    !best || Math.abs(marker.frame - frame) < Math.abs(best.frame - frame) ? marker : best, null)
  const bpm = rhythm.rhythm.settings.correction?.bpm ?? rhythm.analysis?.bpm
  const beatsPerBar = rhythm.rhythm.settings.correction?.beatsPerBar ?? rhythm.analysis?.beatsPerBar ?? null
  const barCount = rhythm.mapped.filter(marker => marker.bar).length
  const canCorrect = master && !sequence.tracks.find((track) => track.trackId === master.trackId)?.locked

  function saveMarkers(markers: RhythmMarker[], nextBpm = bpm ?? null, nextMeter = beatsPerBar) {
    if (!master) return
    setMessage('')
    void rhythm.save({ masterClipId: master.clipId, correction: {
      objectHash: master.source.range.objectHash, analysisId: rhythm.analysis?.analysisId ?? null,
      markers, bpm: nextBpm, beatsPerBar: nextMeter,
    } })
  }

  function tapTempo() {
    const now = performance.now()
    const previous = taps.current[taps.current.length - 1]
    taps.current = previous === undefined || now - previous > 3000 ? [now] : [...taps.current.slice(-7), now]
    if (taps.current.length > 1) {
      const intervals = taps.current.slice(1).map((time, index) => time - taps.current[index]!).sort((a, b) => a - b)
      setTempo(Math.min(400, Math.max(20, 60000 / intervals[Math.floor(intervals.length / 2)]!)).toFixed(1))
    }
    setMessage(`${taps.current.length} taps. Use Set grid from playhead when ready.`)
  }

  function grid() {
    if (!master) return
    const nextBpm = Number(tempo || bpm)
    const nextMeter = meter ? Number(meter) : null
    if (!(nextBpm >= 20 && nextBpm <= 400) || nextMeter !== null && (!Number.isInteger(nextMeter) || nextMeter < 1 || nextMeter > 16)) {
      setMessage('Enter 20–400 BPM and, optionally, 1–16 beats per bar.')
      return
    }
    const range = master.source.range
    const tick = range.timeBase.numerator / range.timeBase.denominator
    const end = (range.startTick + range.durationTicks) * tick
    if (frame < master.timelineStartFrame || frame >= master.timelineStartFrame + master.durationFrames) { setMessage('Place the playhead inside the soundtrack.'); return }
    const start = Math.min(end - tick, sourceTimeAtFrame(master, frame, fps))
    const count = master.reverse ? Math.floor((start - range.startTick * tick) / (60 / nextBpm)) + 1 : Math.ceil((end - start) / (60 / nextBpm))
    const markers = Array.from({ length: Math.max(0, count) }, (_, index) => ({
      id: `grid-${index}`, timeSeconds: start + (master.reverse ? -1 : 1) * index * 60 / nextBpm,
      bar: nextMeter !== null && index % nextMeter === 0, manual: true,
    }))
    saveMarkers(markers, nextBpm, nextMeter)
  }

  function addBeat() {
    if (!master) return
    const range = master.source.range
    const sourceEnd = (range.startTick + range.durationTicks - 1) * range.timeBase.numerator / range.timeBase.denominator
    const timeSeconds = Math.min(sourceEnd, sourceTimeAtFrame(master, frame, fps))
    if (frame < master.timelineStartFrame || frame >= master.timelineStartFrame + master.durationFrames) {
      setMessage('Place the playhead inside the soundtrack.')
      return
    }
    if (rhythm.markers.some((marker) => Math.abs(marker.timeSeconds - timeSeconds) < 0.5 / fps)) return
    saveMarkers([...rhythm.markers, { id: crypto.randomUUID(), timeSeconds, bar: false, manual: true }])
  }

  function setBars() {
    if (!master || !nearest) return
    const nextMeter = meter ? Number(meter) : beatsPerBar
    if (nextMeter === null || !Number.isInteger(nextMeter) || nextMeter < 1 || nextMeter > 16) {
      setMessage('Enter 1–16 beats per bar.')
      return
    }
    if (frame < master.timelineStartFrame || frame >= master.timelineStartFrame + master.durationFrames) {
      setMessage('Place the playhead at the first beat of a bar inside the soundtrack.')
      return
    }
    saveMarkers(groupBeatBars(rhythm.markers, nearest.id, nextMeter, bpm ?? null), bpm ?? null, nextMeter)
  }

  function nudge(direction: number) {
    if (!master || !nearest) return
    const timeSeconds = nearest.timeSeconds + direction / fps * master.speed.numerator / master.speed.denominator * (master.reverse ? -1 : 1)
    if (timeSeconds < 0) return
    saveMarkers(rhythm.markers.map((marker) => marker.id === nearest.id ? { ...marker, timeSeconds, manual: true } : marker))
  }

  return <div className="music-rhythm-controls">
    <div className="music-rhythm-row">
      <label>Soundtrack<select aria-label="Master soundtrack" value={master?.clipId ?? ''} disabled={rhythm.busy} onChange={(event) => void rhythm.save({ masterClipId: event.target.value || null, correction: null })}>
        <option value="">{clips.length ? 'Choose audio clip' : 'Add audio to the timeline'}</option>
        {clips.map((clip) => <option key={clip.clipId} value={clip.clipId}>{assets.find((asset) => asset.artifactId === clip.source.artifactId)?.label ?? 'Audio'} · {(clip.timelineStartFrame / fps).toFixed(1)}s</option>)}
      </select></label>
      <button type="button" disabled={!master || rhythm.busy || pending} onClick={() => void rhythm.analyze(Boolean(rhythm.analysis))}>{rhythm.analysis ? 'Analyze again' : 'Analyze beats'}</button>
      {pending && <button type="button" disabled={rhythm.busy} onClick={() => void rhythm.cancel()}>Cancel analysis</button>}
      <span role="status">{pending ? 'Analyzing soundtrack…' : rhythm.status === 'no-beats' ? 'Analysis complete. No reliable beats found. Set a grid below.' : bpm ? `${bpm.toFixed(1)} BPM · ${rhythm.mapped.length} beats` : 'Analyze the song or set a beat grid.'}</span>
      <button type="button" disabled={rhythm.busy} onClick={() => void rhythm.load()}>Reload beats</button>
    </div>
    {master && (!master.enabled || master.audio?.muted || master.audioPolicy === 'mute' || sequence.tracks.some((track) => track.trackId === master.trackId && (!track.enabled || track.kind === 'audio' && track.muted))) && <p>Soundtrack is muted or disabled. Its beat map is a timing guide.</p>}
    {master?.reverse && <p>Reversed audio is heard in the export. Render the reversed soundtrack to audition it in this preview.</p>}
    {rhythm.analysis?.lowConfidence && rhythm.mapped.length > 0 && !rhythm.rhythm.settings.correction && <p>Beat timing is uncertain. Listen and adjust the markers.</p>}
    {rhythm.rhythm.settings.correction && <p>Using your corrected beat map. Reanalysis preserves this map.</p>}
    <section className="music-bar-setup" aria-label="Bar setup">
      <strong>{barCount ? `${barCount} bar starts · ${beatsPerBar ?? 'Unknown'} beats per bar` : 'Set bar starts'}</strong>
      <p>Place the playhead on the first beat of a bar, then enter the number of beats per bar.</p>
      <div className="music-rhythm-row">
        <label>Beats per bar<input name="beats-per-bar" type="number" min="1" max="16" value={meter} placeholder={beatsPerBar?.toString() ?? 'e.g. 4'} onChange={(event) => setMeter(event.target.value)} /></label>
        <button type="button" disabled={!canCorrect || !nearest || rhythm.busy} onClick={setBars}>Set bars from playhead</button>
      </div>
      {nearest && <small>Use the beat at {(nearest.frame / fps).toFixed(3)}s as a bar start.</small>}
    </section>
    <details className="music-rhythm-fixes" open={correctionsOpen} onToggle={(event) => onCorrectionsOpenChange(event.currentTarget.open)}>
    <summary>Correct the beat grid</summary>
    <div className="music-rhythm-row">
      <label>BPM<input type="number" min="20" max="400" value={tempo} placeholder={bpm?.toFixed(1) ?? '120'} onChange={(event) => setTempo(event.target.value)} /></label>
      <button type="button" disabled={!canCorrect || rhythm.busy} onClick={tapTempo}>Tap tempo</button>
      <button type="button" disabled={!canCorrect || rhythm.busy} onClick={grid}>Set grid from playhead</button>
      <button type="button" disabled={!canCorrect || rhythm.busy} onClick={addBeat}>Add beat at playhead</button>
      <button type="button" disabled={!canCorrect || !nearest || rhythm.busy} onClick={() => saveMarkers(rhythm.markers.filter((marker) => marker.id !== nearest?.id))}>Remove nearest beat</button>
      <button type="button" disabled={!canCorrect || !nearest || rhythm.busy} onClick={() => nudge(-1)}>Beat −1 frame</button>
      <button type="button" disabled={!canCorrect || !nearest || rhythm.busy} onClick={() => nudge(1)}>Beat +1 frame</button>
      <button type="button" disabled={!canCorrect || !nearest || rhythm.busy} onClick={() => saveMarkers(rhythm.markers.map((marker) => marker.id === nearest?.id ? { ...marker, bar: !marker.bar, manual: true } : marker))}>Toggle bar start</button>
    </div>
    <div className="music-rhythm-row">
      {nearest && <span>Nearest beat · {(nearest.frame / fps).toFixed(3)}s{nearest.manual ? ' · adjusted' : ''}</span>}
      {rhythm.analysis?.beats.length && !rhythm.rhythm.settings.correction ? <button type="button" disabled={!canCorrect || rhythm.busy} onClick={() => saveMarkers(rhythm.markers)}>Confirm detected beats</button> : null}
      <button type="button" disabled={!rhythm.rhythm.canUndo || rhythm.busy} onClick={() => void rhythm.save('undo')}>Undo beat change</button>
      <button type="button" disabled={!rhythm.rhythm.canRedo || rhythm.busy} onClick={() => void rhythm.save('redo')}>Redo beat change</button>
      <button type="button" disabled={!rhythm.rhythm.settings.correction || rhythm.busy} onClick={() => void rhythm.save({ ...rhythm.rhythm.settings, correction: null })}>Use detected beats</button>
    </div>
    </details>
    {(message || rhythm.error) && <p role="alert">{message || rhythm.error}</p>}
  </div>
}

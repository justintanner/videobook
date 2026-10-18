import { useId, useRef, useState } from 'react'
import { insertVideoReviewError, insertVideoSource } from '@/videobook/insert-video-review'
import { generationSettingsError, type GenerationControl, type GenerationControlValue } from '@/videobook/notebook-generation-actions'
import type { GenerationReviewSource } from './confirm/bodies/GenerationBody'
import './InsertVideoEditor.css'

type Props = {
  sources: readonly GenerationReviewSource[]
  settings: Record<string, GenerationControlValue>
  controls: readonly GenerationControl[]
  busy: boolean
  onChange: (name: string, value: GenerationControlValue | undefined) => void
}

const timingFields = [
  { name: 'start_time', label: 'Replace from', hint: 'Keep the original before this point.' },
  { name: 'resume_time', label: 'Resume original at', hint: 'Keep the original after this point.' },
  { name: 'duration', label: 'New scene length', hint: 'Generate 5–13 seconds of new footage.' },
] as const

function seconds(value: number): string {
  return `${Number(value.toFixed(3))}s`
}

function valueOf(settings: Props['settings'], name: string): number | undefined {
  const value = settings[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function Segment({ length, title, kind }: { length: number; title: string; kind: 'kept' | 'removed' | 'new' }) {
  if (length <= 0) return null
  return <span className={`insert-video-segment ${kind}`} style={{ flexGrow: length }} title={title}><span>{kind === 'new' ? `New · ${seconds(length)}` : seconds(length)}</span></span>
}

export function InsertVideoEditor({ sources, settings, controls, busy, onChange }: Props) {
  const source = insertVideoSource(sources)
  return <InsertVideoTiming key={source?.asset?.mediaUrl ?? source?.cellId ?? 'empty'} sources={sources} settings={settings} controls={controls} busy={busy} onChange={onChange} />
}

function InsertVideoTiming({ sources, settings, controls, busy, onChange }: Props) {
  const source = insertVideoSource(sources)
  const video = useRef<HTMLVideoElement>(null)
  const [playhead, setPlayhead] = useState(0)
  const [mediaError, setMediaError] = useState(false)
  const errorId = useId()
  const sourceDuration = source?.asset?.duration ?? 0
  const start = valueOf(settings, 'start_time')
  const resume = valueOf(settings, 'resume_time')
  const duration = valueOf(settings, 'duration') ?? Number(controls.find((control) => control.name === 'duration')?.defaultValue ?? 5)
  const timingControls = controls.flatMap((control) => {
    const field = timingFields.find((item) => item.name === control.name)
    return field ? [{ ...control, label: field.label }] : []
  })
  const error = insertVideoReviewError('fal:minimax/h3-max/insert-video', settings, sources)
    ?? generationSettingsError(timingControls, settings)
  const valid = !error && start !== undefined && resume !== undefined
  const total = valid ? start + duration + sourceDuration - resume : null
  const scale = Math.max(sourceDuration, total ?? 0)
  const seek = (time: number) => {
    if (!video.current || !Number.isFinite(video.current.duration)) return
    video.current.currentTime = Math.max(0, Math.min(time, video.current.duration))
  }
  const changeTime = (name: string, value: number | undefined) => {
    onChange(name, value)
    if (value !== undefined && name !== 'duration') seek(value)
  }

  return (
    <section className="insert-video-editor" aria-label="Insert scene timing">
      <header><strong>Insert a new scene</strong><span>{source ? `Original @${source.address} · ${sourceDuration > 0 ? seconds(sourceDuration) : 'duration unavailable'}` : 'Choose an original video'}</span></header>
      <p>Replace a section while keeping the original footage before and after it.</p>
      <div className="insert-video-visuals">
      {source?.asset?.mediaUrl && <div className="insert-video-monitor">
        <video ref={video} src={source.asset.mediaUrl} poster={source.asset.thumbnailUrl ?? undefined} controls playsInline preload="metadata" aria-label="Original video for insert" onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)} onError={() => setMediaError(true)} />
        <div className="insert-video-playhead">
          <span>Scrub to a cut point · {seconds(playhead)}</span>
          <button type="button" disabled={busy || mediaError || playhead < 1.625 || playhead > 60 || playhead >= sourceDuration} onClick={() => changeTime('start_time', Number(playhead.toFixed(3)))}>Replace from here</button>
          <button type="button" disabled={busy || mediaError || playhead <= (start ?? 1.625) || playhead > 60} onClick={() => changeTime('resume_time', Number(playhead.toFixed(3)))}>Resume from here</button>
        </div>
      </div>}
      <div className="insert-video-tracks">
        <div className="insert-video-track-heading"><strong>Original</strong><span>0s → {sourceDuration > 0 ? seconds(sourceDuration) : '—'}</span></div>
        <div className="insert-video-track" role="img" aria-label={valid ? `Original: keep 0 to ${start}s, replace ${start} to ${resume}s, keep ${resume} to ${sourceDuration}s` : 'Original video: choose a valid replacement range'}>
          {valid ? <div className="insert-video-track-content" style={{ width: `${sourceDuration / scale * 100}%` }}><Segment kind="kept" length={start} title={`Keep · ${seconds(start)}`} /><Segment kind="removed" length={resume - start} title={`Replace · ${seconds(resume - start)}`} /><Segment kind="kept" length={sourceDuration - resume} title={`Keep · ${seconds(sourceDuration - resume)}`} /></div> : <span className="insert-video-track-empty">Set the two cut points below</span>}
        </div>
        <div className="insert-video-track-heading"><strong>Result</strong><span>{total === null ? 'Choose a valid range' : `${seconds(total)} total`}</span></div>
        <div className="insert-video-track" role="img" aria-label={total === null ? 'Result preview unavailable until timing is valid' : `Result: ${start}s original opening, ${duration}s new scene, ${seconds(sourceDuration - resume!)} original ending, ${seconds(total)} total`}>
          {valid ? <div className="insert-video-track-content" style={{ width: `${total! / scale * 100}%` }}><Segment kind="kept" length={start} title={`Opening · ${seconds(start)}`} /><Segment kind="new" length={duration} title={`New scene · ${seconds(duration)}`} /><Segment kind="kept" length={sourceDuration - resume} title={`Ending · ${seconds(sourceDuration - resume)}`} /></div> : <span className="insert-video-track-empty">Original opening → new scene → original ending</span>}
        </div>
        <div className="insert-video-legend"><span className="kept">Original footage</span><span className="removed">Replaced section</span><span className="new">Generated scene</span></div>
      </div>
      </div>
      {mediaError && <p role="status">Source playback is unavailable. You can still set the cut points below.</p>}
      <div className="insert-video-fields">
        {timingFields.map((field) => {
          const control = controls.find((item) => item.name === field.name)
          const value = valueOf(settings, field.name) ?? (field.name === 'duration' ? duration : undefined)
          const maximum = field.name === 'duration' ? 13 : Math.min(60, sourceDuration || 60)
          return <div className="insert-video-field" key={field.name}>
            <label htmlFor={`${errorId}-${field.name}`}><span>{field.label} <small>(seconds)</small></span></label>
            <div className="insert-video-time-input">
              <input id={`${errorId}-${field.name}`} type="number" step="any" min={control?.minimum} max={maximum} value={value ?? ''} disabled={busy} aria-describedby={error ? errorId : undefined} aria-invalid={Boolean(error)} onChange={(event) => changeTime(field.name, event.target.value === '' ? undefined : event.target.valueAsNumber)} />
              {field.name !== 'duration' && <button type="button" aria-label={`View ${field.label.toLowerCase()} cut point`} disabled={busy || value === undefined || value > sourceDuration || mediaError || !source?.asset?.mediaUrl} onClick={() => seek(value!)}>View</button>}
            </div>
            <input type="range" aria-label={`${field.label} slider`} min={field.name === 'duration' ? 5 : 1.625} max={Math.max(field.name === 'duration' ? 5 : 1.625, maximum)} step="0.001" value={Math.min(maximum, Math.max(field.name === 'duration' ? 5 : 1.625, value ?? 1.625))} disabled={busy || (field.name !== 'duration' && sourceDuration <= 1.625)} onChange={(event) => changeTime(field.name, event.target.valueAsNumber)} />
            <small>{field.hint}</small>
          </div>
        })}
      </div>
      {error ? <p className="insert-video-error" id={errorId} role="alert">{error}</p> : valid && <p className="insert-video-summary" role="status">Replace {seconds(start)}–{seconds(resume)} of @{source?.address} with {seconds(duration)} of new footage. Result: {seconds(total!)}.</p>}
    </section>
  )
}

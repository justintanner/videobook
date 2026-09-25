import type { ReactNode } from 'react'
import type { AliveMotion, AliveSettings, AliveStyle } from '../../../server/src/remotion/subtitles/alive-types'
import type { AliveWordRow } from '@/videobook/alive-captions'
import { formatAliveTime } from '@/videobook/alive-captions'

const STYLE_OPTIONS: ReadonlyArray<{ id: AliveStyle; label: string; hint: string }> = [
  { id: 'stack', label: 'Stack', hint: 'Words land one by one and build a stacked block beside the subject, each line sized to fill the column.' },
  { id: 'punch', label: 'Punch', hint: 'One word at a time, as big as the free space allows. Best on fast verses.' },
  { id: 'karaoke', label: 'Karaoke', hint: 'The whole stacked phrase shows dimmed and lights up word by word.' },
]

const MOTION_OPTIONS: ReadonlyArray<{ id: AliveMotion; label: string }> = [
  { id: 'pop', label: 'Pop' },
  { id: 'slam', label: 'Slam' },
  { id: 'rise', label: 'Rise' },
]

const HIT_SWATCHES: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Green', color: '#72E7AA' },
  { name: 'Pink', color: '#F0B9D0' },
  { name: 'Cyan', color: '#63C7D8' },
  { name: 'Amber', color: '#E7C372' },
]

type TranscriptPanelProps = {
  rows: AliveWordRow[]
  phraseLabels: string[]
  activePhrase: number
  time: number
  snapped: boolean
  onSeek: (seconds: number) => void
}

function wordSub(row: AliveWordRow, snapped: boolean): string {
  if (!row.drifted) return formatAliveTime(row.start)
  const sign = row.driftMs > 0 ? '+' : ''
  return snapped ? `${formatAliveTime(row.start)} · snapped` : `${formatAliveTime(row.start)} · ${sign}${row.driftMs}ms`
}

export function AliveTranscriptPanel({ rows, phraseLabels, activePhrase, time, snapped, onSeek }: TranscriptPanelProps) {
  return (
    <section className="alive-panel alive-transcript" aria-label="Transcript">
      <header className="alive-panel-header">
        <h3>Transcript</h3>
        <p>{rows.length} words · timed to the vocal</p>
      </header>
      <div className="alive-transcript-list">
        {phraseLabels.map((label, phraseIndex) => (
          <div key={`${phraseIndex}-${label}`} className="alive-phrase" data-active={phraseIndex === activePhrase || undefined}>
            <div className="alive-phrase-head"><span>Phrase {phraseIndex + 1}</span><span>{label}</span></div>
            <div className="alive-phrase-words">
              {rows.filter((row) => row.phraseIndex === phraseIndex).map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className="alive-word"
                  data-active={(time >= row.start && time < row.end) || undefined}
                  data-drifted={(row.drifted && !snapped) || undefined}
                  onClick={() => onSeek(row.start + 0.03)}
                >
                  <span>{row.text}</span>
                  <small>{wordSub(row, snapped)}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string
  options: ReadonlyArray<{ id: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="alive-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={option.id === value} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="alive-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {children}
    </label>
  )
}

type SettingsPanelProps = {
  settings: AliveSettings
  showRegions: boolean
  regionsAnalyzed: boolean
  working: boolean
  onChange: (patch: Partial<AliveSettings>) => void
  onShowRegions: (show: boolean) => void
  onReanalyze: () => void
}

export function AliveSettingsPanel({ settings, showRegions, regionsAnalyzed, working, onChange, onShowRegions, onReanalyze }: SettingsPanelProps) {
  const hint = STYLE_OPTIONS.find((option) => option.id === settings.style)?.hint
  return (
    <section className="alive-panel alive-settings" aria-label="Caption settings">
      <div className="alive-field">
        <h4>Style</h4>
        <Segmented label="Caption style" options={STYLE_OPTIONS} value={settings.style} onChange={(style) => onChange({ style })} />
        <p className="alive-hint">{hint}</p>
      </div>
      <div className="alive-field">
        <h4>Word entrance</h4>
        <Segmented label="Word entrance" options={MOTION_OPTIONS} value={settings.motion} onChange={(motion) => onChange({ motion })} />
      </div>
      <div className="alive-field">
        <h4>Frame awareness</h4>
        <Toggle checked={settings.avoidFaces} onChange={(avoidFaces) => onChange({ avoidFaces })}>Keep words off faces</Toggle>
        <Toggle checked={settings.avoidText} onChange={(avoidText) => onChange({ avoidText })}>Keep words off on-screen text</Toggle>
        <Toggle checked={showRegions} onChange={onShowRegions}>Show detected regions</Toggle>
        {!regionsAnalyzed && (
          <p className="alive-hint alive-warning">Face and text detection did not run, so stacks use the default columns. Set OPENAI_API_KEY and re-run the analysis.</p>
        )}
      </div>
      <div className="alive-field">
        <h4>Audio</h4>
        <Toggle checked={settings.energySizing} onChange={(energySizing) => onChange({ energySizing })}>Size words by vocal energy</Toggle>
      </div>
      <div className="alive-field">
        <h4>Hit color</h4>
        <div className="alive-swatches">
          {HIT_SWATCHES.map((swatch) => (
            <button
              key={swatch.color}
              type="button"
              aria-label={swatch.name}
              aria-pressed={settings.hitColor.toUpperCase() === swatch.color}
              onClick={() => onChange({ hitColor: swatch.color })}
            >
              <span style={{ background: swatch.color }} />
            </button>
          ))}
          <label className="alive-color-input">
            <span>Text</span>
            <input type="color" value={settings.textColor} onChange={(event) => onChange({ textColor: event.target.value.toUpperCase() })} />
          </label>
        </div>
      </div>
      <div className="alive-field">
        <button type="button" className="alive-secondary" disabled={working} onClick={onReanalyze}>Re-run analysis</button>
      </div>
    </section>
  )
}

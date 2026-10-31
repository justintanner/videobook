import { useState, type CSSProperties } from 'react'
import { formatSpeedMultiplier } from '@/videobook/chat-action-review'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  clampSection,
  lastSecondsSection,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  speedChangeOutcome,
  type SpeedChangeDraft,
  type SpeedChangeOutcome,
  type SpeedChangeSection,
} from '@/videobook/speed-change-draft'
import { PromptEcho } from './RoutedSettings'
import { SpeedChangePreview } from './SpeedChangePreview'

export interface SpeedChangeSource {
  assetId: string
  address: string
  durationSeconds: number | null
}

export interface SpeedChangeMedia {
  mediaUrl: string | null
  thumbnailUrl: string | null
  unavailableReason: string | null
}

export interface SpeedChangeEdit {
  assetId: string
  draft: SpeedChangeDraft
}

type SpeedChangeBodyProps = {
  prompt: string
  assetId: string
  sources: readonly SpeedChangeSource[]
  durationSeconds: number | null
  draft: SpeedChangeDraft
  media: SpeedChangeMedia
  onChange: (edit: SpeedChangeEdit) => void
}

const QUICK_SECTIONS = [
  { label: 'Last 3s', seconds: 3 },
  { label: 'Last 6s', seconds: 6 },
] as const

function percent(value: number, total: number): string {
  return `${Math.max(0, Math.min(100, (value / total) * 100))}%`
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  invalid = false,
  onCommit,
}: {
  label: string
  value: number | null
  min: number
  max?: number
  step: number
  invalid?: boolean
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <label className="confirm-speed-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        aria-invalid={invalid || undefined}
        value={text ?? (value === null ? '' : String(Number(value.toFixed(2))))}
        onChange={(event) => {
          setText(event.target.value)
          const next = Number(event.target.value)
          if (event.target.value.trim() !== '' && Number.isFinite(next)) onCommit(next)
        }}
        onBlur={() => setText(null)}
      />
    </label>
  )
}

function SectionTimeline({
  durationSeconds,
  section,
  onSection,
}: {
  durationSeconds: number
  section: SpeedChangeSection
  onSection: (section: SpeedChangeSection) => void
}) {
  const highlight: CSSProperties = {
    left: percent(section.startSeconds, durationSeconds),
    width: percent(section.endSeconds - section.startSeconds, durationSeconds),
  }
  return (
    <div className="confirm-speed-timeline">
      <div className="confirm-speed-track" aria-hidden="true">
        <div className="confirm-speed-track-section" style={highlight} />
      </div>
      <input
        type="range"
        aria-label="Section start"
        min={0}
        max={durationSeconds}
        step={0.01}
        value={section.startSeconds}
        onChange={(event) => onSection(clampSection(
          { startSeconds: Number(event.target.value), endSeconds: section.endSeconds },
          durationSeconds,
        ))}
      />
    </div>
  )
}

function SectionControls({
  durationSeconds,
  section,
  onSection,
}: {
  durationSeconds: number
  section: SpeedChangeSection
  onSection: (section: SpeedChangeSection) => void
}) {
  const commit = (next: SpeedChangeSection) => onSection(clampSection(next, durationSeconds))
  return (
    <>
      <SectionTimeline durationSeconds={durationSeconds} section={section} onSection={onSection} />
      <div className="confirm-speed-fields">
        <NumberField
          label="Start (s)"
          value={section.startSeconds}
          min={0}
          max={durationSeconds}
          step={0.01}
          onCommit={(startSeconds) => commit({ ...section, startSeconds })}
        />
        <NumberField
          label="End (s)"
          value={section.endSeconds}
          min={0}
          max={durationSeconds}
          step={0.01}
          onCommit={(endSeconds) => commit({ ...section, endSeconds })}
        />
        <div className="confirm-speed-field">
          <span>Length</span>
          <output>{formatMediaTime(section.endSeconds - section.startSeconds)}</output>
        </div>
      </div>
      <div className="confirm-chips">
        {QUICK_SECTIONS.map((quick) => (
          <button
            key={quick.label}
            type="button"
            disabled={quick.seconds >= durationSeconds}
            onClick={() => onSection(lastSecondsSection(quick.seconds, durationSeconds))}
          >
            {quick.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onSection(lastSecondsSection(durationSeconds / 2, durationSeconds))}
        >
          Second half
        </button>
      </div>
    </>
  )
}

function SpeedControls({
  draft,
  outcome,
  onDraft,
}: {
  draft: SpeedChangeDraft
  outcome: SpeedChangeOutcome
  onDraft: (draft: SpeedChangeDraft) => void
}) {
  const setSpeed = (speed: number) => onDraft({ ...draft, speed, targetSeconds: null })
  const speed = outcome.effectiveSpeed
  return (
    <section className="confirm-section" aria-label="Speed">
      <div className="confirm-section-heading">
        <span>Speed</span>
        <strong>{speed === null ? '—' : `${formatSpeedMultiplier(speed)}×`}</strong>
      </div>
      <div className="confirm-chips" role="group" aria-label="Speed presets">
        {SPEED_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={speed === preset ? 'active' : undefined}
            aria-pressed={speed === preset}
            onClick={() => setSpeed(preset)}
          >
            {`${preset}×`}
          </button>
        ))}
      </div>
      <input
        className="confirm-speed-slider"
        type="range"
        aria-label="Speed"
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={0.05}
        value={speed ?? 1}
        onChange={(event) => setSpeed(Number(event.target.value))}
      />
      <div className="confirm-speed-fields">
        <NumberField
          label="Speed (×)"
          value={speed}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          invalid={outcome.error !== null && draft.speed !== null}
          onCommit={setSpeed}
        />
        <NumberField
          label="Target duration (s)"
          value={outcome.outputSeconds}
          min={0.1}
          step={0.01}
          invalid={outcome.error !== null && draft.speed === null}
          onCommit={(targetSeconds) => onDraft({ ...draft, speed: null, targetSeconds })}
        />
      </div>
      {outcome.error
        ? <p className="confirm-field-error" role="alert">{outcome.error}</p>
        : <p className="confirm-help">Speed and target duration are linked. Edit either one.</p>}
    </section>
  )
}

function DurationComparison({
  durationSeconds,
  outcome,
}: {
  durationSeconds: number
  outcome: SpeedChangeOutcome
}) {
  const end = outcome.sectionEndSeconds ?? durationSeconds
  const start = outcome.sectionStartSeconds
  const sped = outcome.effectiveSpeed ? (end - start) / outcome.effectiveSpeed : end - start
  const output = outcome.outputSeconds
  const delta = output === null ? null : output - durationSeconds
  return (
    <section className="confirm-section confirm-speed-compare" aria-label="Duration change">
      <span>Before</span>
      <div className="confirm-speed-bar">
        <i style={{ width: percent(start, durationSeconds) }} />
        <i className="sped" style={{ width: percent(end - start, durationSeconds) }} />
        <i style={{ width: percent(durationSeconds - end, durationSeconds) }} />
      </div>
      <output>{formatMediaTime(durationSeconds)}</output>
      <span>After</span>
      <div className="confirm-speed-bar">
        <i style={{ width: percent(start, durationSeconds) }} />
        <i className="sped after" style={{ width: percent(sped, durationSeconds) }} />
        <i style={{ width: percent(durationSeconds - end, durationSeconds) }} />
      </div>
      <output>{output === null ? '—' : formatMediaTime(output)}</output>
      {delta !== null && (
        <p className="confirm-help">
          {`${Math.abs(delta).toFixed(2)}s ${delta <= 0 ? 'shorter' : 'longer'}`}
        </p>
      )}
    </section>
  )
}

function SpeedPreviewPane({
  media,
  outcome,
  durationSeconds,
  sectioned,
}: {
  media: SpeedChangeMedia
  outcome: SpeedChangeOutcome
  durationSeconds: number | null
  sectioned: boolean
}) {
  return (
    <div className="confirm-routed-preview" aria-label="Speed change preview">
      {media.unavailableReason === null && media.mediaUrl ? (
        <SpeedChangePreview
          key={media.mediaUrl}
          effectiveSpeed={outcome.effectiveSpeed}
          mediaUrl={media.mediaUrl}
          thumbnailUrl={media.thumbnailUrl}
          sectionStartSeconds={sectioned ? outcome.sectionStartSeconds : 0}
          sectionEndSeconds={sectioned ? outcome.sectionEndSeconds : null}
        />
      ) : (
        <p className="confirm-routed-preview-fallback">
          {`Preview unavailable — ${media.unavailableReason ?? 'the source media is not loaded yet'}.`}
        </p>
      )}
      {durationSeconds !== null && <DurationComparison durationSeconds={durationSeconds} outcome={outcome} />}
    </div>
  )
}

export function SpeedChangeBody({
  prompt,
  assetId,
  sources,
  durationSeconds,
  draft,
  media,
  onChange,
}: SpeedChangeBodyProps) {
  const outcome = speedChangeOutcome(draft, durationSeconds)
  const sectioned = draft.section !== null && durationSeconds !== null
  const section = sectioned
    ? clampSection(draft.section!, durationSeconds!)
    : null
  const onDraft = (next: SpeedChangeDraft) => onChange({ assetId, draft: next })
  const onSection = (next: SpeedChangeSection | null) => onDraft({ ...draft, section: next })
  const onSource = (nextAssetId: string) => {
    const next = sources.find((source) => source.assetId === nextAssetId)
    const nextSection = draft.section && next?.durationSeconds
      ? clampSection(draft.section, next.durationSeconds)
      : null
    onChange({ assetId: nextAssetId, draft: { ...draft, section: nextSection } })
  }
  const address = sources.find((source) => source.assetId === assetId)?.address ?? 'this clip'
  return (
    <div className="confirm-routed confirm-routed-with-preview confirm-speed">
      <div className="confirm-routed-main">
        <PromptEcho prompt={prompt} />
        <section className="confirm-section confirm-speed-source" aria-label="Source">
          <label className="confirm-speed-field">
            <span>Source</span>
            <select value={assetId} onChange={(event) => onSource(event.target.value)}>
              {sources.map((source) => (
                <option key={source.assetId} value={source.assetId}>{source.address}</option>
              ))}
            </select>
          </label>
          <div className="confirm-speed-field">
            <span>Source duration</span>
            <output>{durationSeconds === null ? 'Unknown' : formatMediaTime(durationSeconds)}</output>
          </div>
        </section>
        <section className="confirm-section" aria-label="Apply to">
          <div className="confirm-section-heading">
            <span>Apply to</span>
            <div className="confirm-chips" role="group" aria-label="Apply to">
              <button
                type="button"
                className={sectioned ? undefined : 'active'}
                aria-pressed={!sectioned}
                onClick={() => onSection(null)}
              >
                Whole clip
              </button>
              <button
                type="button"
                className={sectioned ? 'active' : undefined}
                aria-pressed={sectioned}
                disabled={durationSeconds === null}
                onClick={() => onSection(lastSecondsSection(Math.min(6, durationSeconds! / 2), durationSeconds!))}
              >
                A section
              </button>
            </div>
          </div>
          {section && durationSeconds !== null && (
            <SectionControls durationSeconds={durationSeconds} section={section} onSection={onSection} />
          )}
        </section>
        <SpeedControls draft={draft} outcome={outcome} onDraft={onDraft} />
        <p className="confirm-help confirm-speed-output">
          {`Replaces ${address} in place. The previous version stays in its history.`}
        </p>
      </div>
      <SpeedPreviewPane
        media={media}
        outcome={outcome}
        durationSeconds={durationSeconds}
        sectioned={sectioned}
      />
    </div>
  )
}

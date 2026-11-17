import { useState, type ReactNode } from 'react'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import type { GoalEstimate } from '../../../server/src/goal-store'
import { goalBrandingTitleSlots } from '../../../server/src/goal-finish-model'
import { formatGoalSeconds } from '@/videobook/goals'
import type { AssetRecord } from '@/videobook/workspace-responses'

type Props = {
  analysis: GoalRemixAnalysis
  estimate: GoalEstimate
  qualityEstimate?: GoalEstimate
  disabled: boolean
  resolveAsset: (artifactId: string) => AssetRecord | null
  onChange: (analysis: GoalRemixAnalysis) => void
  onSaveDefaults: () => void
  onAnalyze: () => void
  onRefreshFinish: () => void
}
type Intent = GoalRemixAnalysis['intent']
type Span = { start: number, end: number }
type TimelineSpan = Span & { tone: 'keep' | 'change' | 'reference', label: string }
type Choice<Value extends string> = readonly [Value, string]

const STRUCTURES: readonly Choice<Intent['structure']>[] = [['preserve-source', 'Keep source shots'], ['regenerate', 'Regenerate'], ['single-take', 'One take']]
const CHARACTERS: readonly Choice<Intent['character']>[] = [['replace', 'Replace a person'], ['insert', 'Insert a person']]
const AUDIO: readonly Choice<Intent['audio']>[] = [['source', 'Original'], ['generated', 'Generated'], ['mix', 'Mix'], ['mute', 'Mute']]
const CLEANUP: readonly Choice<Intent['cleanup']>[] = [['keep', 'Keep'], ['remove', 'Remove'], ['review', 'Review']]
const SOUND_LINES: Record<Intent['audio'], string> = { source: 'Original audio', generated: 'Generated sound', mix: 'Original and generated sound', mute: 'No sound' }
const SUMMARY_PREVIEW_LENGTH = 180

function range(span: Span): string {
  return `${formatGoalSeconds(span.start)}–${formatGoalSeconds(span.end)} s`
}

function percent(value: number, total: number): string {
  return `${Math.min(100, Math.max(0, value / total * 100)).toFixed(3)}%`
}

function Segmented<Value extends string>({ label, name, value, choices, onPick }: { label: string, name: string, value: Value, choices: readonly Choice<Value>[], onPick: (value: Value) => void }) {
  return <div className="goal-segmented" role="group" aria-label={name}>
    <span>{label}</span>
    <div>{choices.map(([id, text]) => <button key={id} type="button" aria-pressed={id === value} onClick={() => onPick(id)}>{text}</button>)}</div>
  </div>
}

function Timeline({ label, legend, seconds, spans, marks, markTone, axis }: { label: string, legend: ReactNode, seconds: number, spans: readonly TimelineSpan[], marks: readonly number[], markTone: 'cut' | 'check', axis: readonly number[] }) {
  return <div className="goal-timeline-row">
    <div className="goal-timeline-head"><span>{label}</span>{legend}</div>
    <div className="goal-timeline" data-marks={markTone} role="img" aria-label={`${label}: ${spans.map(span => `${span.label} ${range(span)}`).join(', ') || 'no ranges'}`}>
      {spans.map(span => <i key={`${span.tone}:${span.start}:${span.end}`} data-tone={span.tone} style={{ left: percent(span.start, seconds), width: percent(span.end - span.start, seconds) }}><span>{span.label}</span></i>)}
      {marks.map((mark, index) => <b key={`${index}:${mark}`} style={{ left: percent(mark, seconds) }} />)}
    </div>
    <div className="goal-timeline-axis" aria-hidden="true">{axis.map(tick => <span key={tick} style={{ left: percent(tick, seconds) }}>{formatGoalSeconds(tick)}</span>)}</div>
  </div>
}

function SourceCard({ analysis, resolveAsset }: Pick<Props, 'analysis' | 'resolveAsset'>) {
  const [open, setOpen] = useState(false)
  const { source, findings } = analysis
  const summary = source?.observations?.summary ?? ''
  const long = summary.length > SUMMARY_PREVIEW_LENGTH
  const video = source ? resolveAsset(source.artifactId) : null
  return <section className="goal-recipe-card" aria-label="Source">
    <h3>{source ? 'What is in the source' : 'Brief'}</h3>
    {source && <div className="goal-recipe-source">
      {video?.mediaUrl && <video src={video.mediaUrl} poster={video.thumbnailUrl ?? undefined} controls playsInline preload="metadata" aria-label="Source video" />}
      <p className="goal-panel-muted">{formatGoalSeconds(source.durationSeconds)} s · {source.width} × {source.height} · {Math.round(source.fps)} fps · {source.hasAudio ? 'has audio' : 'no audio'}</p>
    </div>}
    {!source && <p className="goal-analysis-summary" data-open="true">{analysis.brief}</p>}
    {summary && <p className="goal-analysis-summary" data-open={open || !long}>{summary}</p>}
    {long && <button type="button" className="goal-link-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Show less' : 'Read all'}</button>}
    {findings.length > 0 && <ul className="goal-short-notes" aria-label="Initial analysis findings">{findings.map((finding, index) => <li key={`${finding.code}:${index}`} data-severity={finding.severity}>{finding.text}</li>)}</ul>}
    {analysis.history.some(entry => entry.failure === 'account') && <p className="goal-panel-warning">An earlier request failed because of account access or credits. Resolve that before another paid request; earlier images are kept.</p>}
    {analysis.history.some(entry => entry.failure === 'request') && <p className="goal-panel-warning">An earlier request failed validation. Check the current request before retrying.</p>}
  </section>
}

function BuildCard({ analysis, estimate, qualityEstimate, disabled, setBoundary }: Pick<Props, 'analysis' | 'estimate' | 'qualityEstimate' | 'disabled'> & { setBoundary: (key: 'start' | 'end', value: string) => void }) {
  const { intent, source, recipe, preferences } = analysis
  const output: TimelineSpan[] = [...recipe.keep.map(span => ({ ...span, tone: 'keep' as const, label: 'Source' })), ...recipe.change.map(span => ({ ...span, tone: 'change' as const, label: 'Generated' }))]
  const boundaries = [...new Set([0, ...recipe.change.flatMap(span => [span.start, span.end]), recipe.targetSeconds])].sort((left, right) => left - right)
  const sound = SOUND_LINES[intent.audio]
  const soundtrack = intent.audio === 'source' || intent.audio === 'mix' ? ` from ${formatGoalSeconds(recipe.soundtrack?.startSeconds ?? 0)} s of the source` : ''
  return <section className="goal-recipe-card" aria-label="How the short is built">
    <h3>How the short is built</h3>
    {source && <Timeline label={`Source · ${formatGoalSeconds(source.durationSeconds)} s · ${source.cuts.length} cut${source.cuts.length === 1 ? '' : 's'}`}
      legend={<span className="goal-timeline-legend"><b aria-hidden="true" />cut</span>} seconds={source.durationSeconds}
      spans={recipe.reference ? [{ ...recipe.reference, tone: 'reference', label: 'Reference' }] : []} marks={source.cuts} markTone="cut" axis={[0, source.durationSeconds]} />}
    <Timeline label={`The short · ${formatGoalSeconds(recipe.targetSeconds)} s`} legend={recipe.outputAssertions ? <span className="goal-timeline-legend" data-tone="check"><b aria-hidden="true" />check</span> : null}
      seconds={recipe.targetSeconds} spans={output} marks={recipe.outputAssertions ? recipe.checkTimes : []} markTone="check" axis={boundaries} />
    <div className="goal-analysis-row">
      <label>Action from<input aria-label="Action start seconds" type="number" min="0" max={recipe.targetSeconds} step="0.01" value={intent.action?.start ?? ''} disabled={disabled} onChange={event => setBoundary('start', event.target.value)} /></label>
      <label>to<input aria-label="Action end seconds" type="number" min="0" max={recipe.targetSeconds} step="0.01" value={intent.action?.end ?? ''} disabled={disabled} onChange={event => setBoundary('end', event.target.value)} /></label>
      <span className="goal-panel-muted">{formatGoalSeconds(recipe.generatedSeconds)} s generated</span>
    </div>
    <p className="goal-panel-muted">Sound: {sound}{soundtrack}.{intent.audio === 'source' ? ' The generated clip is muted.' : ''}</p>
    <details className="goal-analysis-details">
      <summary>How this runs</summary>
      {recipe.outputAssertions && <p className="goal-panel-muted">File checks run on this computer when an output is ready. Visual samples are planned at {recipe.checkTimes.map(time => `${formatGoalSeconds(time)} s`).join(', ')}. A playable file does not prove that it meets the brief.</p>}
      {recipe.outputAssertions && qualityEstimate && <p className="goal-panel-muted">Optional visual review: {qualityEstimate.warnings.join(' ')}</p>}
      {recipe.assembly && <p className="goal-panel-muted">Keep {formatGoalSeconds((recipe.assembly.changeEndFrame - recipe.assembly.changeStartFrame) / recipe.assembly.fps)} s of the generated action after review. Assemble {recipe.assembly.totalFrames} frames at {recipe.assembly.fps.toFixed(3)} fps, {recipe.assembly.width} × {recipe.assembly.height}, with straight cuts.</p>}
      {source && <p className="goal-panel-muted">Reference: {recipe.reference ? range(recipe.reference) : 'not chosen'} · {recipe.cleanupRegions.length} proposed removal regions.</p>}
      {recipe.branding && <p className="goal-panel-muted">Branding: {preferences.branding ? `${recipe.branding.template?.name ?? recipe.branding.starterId ?? 'Book watermark'} · @${recipe.branding.profile.handle.replace(/^@/, '')}` : 'off'}. {goalBrandingTitleSlots(recipe.branding, preferences.branding).headline ? 'A burned title is optional.' : 'This look has no burned headline.'}</p>}
      {analysis.history.length > 0 && <p className="goal-panel-muted">{analysis.history.length} related earlier attempts · {analysis.history.filter(entry => entry.reusable).length} reviewed images can be reused. Other takes stay under Takes.</p>}
      {estimate.warnings.length > 0 && <p className="goal-panel-muted">{estimate.warnings.join(' ')}</p>}
    </details>
  </section>
}

export function GoalRecipe({ analysis, estimate, qualityEstimate, disabled, resolveAsset, onChange, onSaveDefaults, onAnalyze, onRefreshFinish }: Props) {
  const { intent, recipe, preferences } = analysis
  const update = <Key extends keyof Intent>(key: Key, value: Intent[Key]) => onChange({ ...analysis, intent: { ...intent, [key]: value } })
  const prefer = (change: Partial<GoalRemixAnalysis['preferences']>) => onChange({ ...analysis, preferences: { ...preferences, ...change } })
  const setBoundary = (key: 'start' | 'end', value: string) => {
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return
    update('action', { start: intent.action?.start ?? 0, end: intent.action?.end ?? recipe.targetSeconds, [key]: seconds })
  }
  return <section className="goal-recipe" aria-label="Recipe">
    <SourceCard analysis={analysis} resolveAsset={resolveAsset} />
    <BuildCard analysis={analysis} estimate={estimate} qualityEstimate={qualityEstimate} disabled={disabled} setBoundary={setBoundary} />
    <fieldset disabled={disabled} className="goal-recipe-card goal-recipe-choices" aria-label="Choices">
      <h3>Choices</h3>
      <Segmented label="Shots" name="Remix structure" value={intent.structure} choices={STRUCTURES} onPick={value => update('structure', value)} />
      <Segmented label="Character" name="Character role" value={intent.character} choices={CHARACTERS} onPick={value => update('character', value)} />
      <Segmented label="Sound" name="Remix audio" value={intent.audio} choices={AUDIO} onPick={value => update('audio', value)} />
      {analysis.source && <Segmented label="Graphics" name="Source graphics" value={intent.cleanup} choices={CLEANUP} onPick={value => update('cleanup', value)} />}
      <div className="goal-recipe-switches">
        <label className="goal-analysis-switch"><input type="checkbox" checked={intent.noDialogue} onChange={event => update('noDialogue', event.target.checked)} />No new dialogue</label>
        <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.branding} onChange={event => prefer({ branding: event.target.checked })} />Apply saved branding</label>
        <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.reviewImages} onChange={event => prefer({ reviewImages: event.target.checked })} />Stop to review each new image</label>
        <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.autoContinue} onChange={event => prefer({ autoContinue: event.target.checked })} />Offer automatic continuation for this recipe</label>
      </div>
      {preferences.autoContinue && <div className="goal-analysis-row goal-analysis-nested">
        <label>Default allowance (USD)<input aria-label="Default continuation allowance USD" type="number" min="0" step="0.01" value={preferences.allowanceUsd ?? ''} onChange={event => prefer({ allowanceUsd: event.target.value === '' ? null : Math.max(0, Number(event.target.value)) })} /></label>
        {recipe.outputAssertions && <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.semanticChecks} onChange={event => prefer({ semanticChecks: event.target.checked })} />Require sampled visual review before automatic continuation</label>}
      </div>}
      <div className="goal-recipe-actions">
        <button type="button" className="goal-link-button" onClick={onSaveDefaults}>Use these defaults for this book</button>
        <button type="button" className="goal-link-button" onClick={onAnalyze}>Refresh analysis</button>
        <button type="button" className="goal-link-button" onClick={onRefreshFinish}>Use current book branding</button>
      </div>
    </fieldset>
  </section>
}

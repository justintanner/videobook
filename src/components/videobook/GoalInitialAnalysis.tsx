import { useState } from 'react'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import type { GoalEstimate } from '../../../server/src/goal-store'
import { goalBrandingTitleSlots } from '../../../server/src/goal-finish-model'
import { shortEstimateText } from '@/videobook/goals'

type Props = {
  analysis: GoalRemixAnalysis
  estimate: GoalEstimate
  qualityEstimate?: GoalEstimate
  disabled: boolean
  onChange: (analysis: GoalRemixAnalysis) => void
  onSaveDefaults: () => void
  onAnalyze: () => void
  onRefreshFinish: () => void
}

type Span = { start: number; end: number }
type TimelineSpan = Span & { tone: 'keep' | 'change' | 'reference' }
type Choice<Value extends string> = readonly [Value, string]

const STRUCTURES: readonly Choice<GoalRemixAnalysis['intent']['structure']>[] = [['preserve-source', 'Keep source shots'], ['regenerate', 'Regenerate the video'], ['single-take', 'One continuous take']]
const CHARACTERS: readonly Choice<GoalRemixAnalysis['intent']['character']>[] = [['insert', 'Insert a person'], ['replace', 'Replace a person']]
const AUDIO: readonly Choice<GoalRemixAnalysis['intent']['audio']>[] = [['source', 'Original audio'], ['generated', 'Generated sound'], ['mix', 'Mix original and generated'], ['mute', 'Muted']]
const CLEANUP: readonly Choice<GoalRemixAnalysis['intent']['cleanup']>[] = [['review', 'Review source graphics'], ['remove', 'Remove source graphics'], ['keep', 'Keep source graphics']]
const SUMMARY_PREVIEW_LENGTH = 220

function ranges(values: readonly Span[]): string {
  return values.map(value => `${value.start.toFixed(2)}–${value.end.toFixed(2)}s`).join(', ') || 'None'
}

function percent(value: number, total: number): string {
  return `${Math.min(100, Math.max(0, value / total * 100)).toFixed(2)}%`
}

function choiceName<Value extends string>(choices: readonly Choice<Value>[], value: Value): string {
  return choices.find(choice => choice[0] === value)?.[1] ?? value
}

function Segmented<Value extends string>({ label, name, value, choices, onPick }: { label: string, name: string, value: Value, choices: readonly Choice<Value>[], onPick: (value: Value) => void }) {
  return <div className="goal-segmented" role="group" aria-label={name}>
    <span>{label}</span>
    <div>{choices.map(([id, text]) => <button key={id} type="button" aria-pressed={id === value} onClick={() => onPick(id)}>{text}</button>)}</div>
  </div>
}

function Timeline({ label, seconds, spans, ticks }: { label: string, seconds: number, spans: readonly TimelineSpan[], ticks: readonly number[] }) {
  return <div className="goal-timeline" role="img" aria-label={label}>
    {spans.map(span => <i key={`${span.tone}:${span.start}:${span.end}`} data-tone={span.tone} style={{ left: percent(span.start, seconds), width: percent(span.end - span.start, seconds) }} />)}
    {ticks.map((tick, index) => <b key={`${index}:${tick}`} style={{ left: percent(tick, seconds) }} />)}
  </div>
}

export function GoalInitialAnalysis({ analysis, estimate, qualityEstimate, disabled, onChange, onSaveDefaults, onAnalyze, onRefreshFinish }: Props) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const { intent, source, recipe, findings, preferences } = analysis
  const update = <Key extends keyof GoalRemixAnalysis['intent']>(key: Key, value: GoalRemixAnalysis['intent'][Key]) => {
    onChange({ ...analysis, intent: { ...intent, [key]: value } })
  }
  const prefer = (change: Partial<GoalRemixAnalysis['preferences']>) => onChange({ ...analysis, preferences: { ...preferences, ...change } })
  const setBoundary = (key: 'start' | 'end', value: string) => {
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return
    update('action', { start: intent.action?.start ?? 0, end: intent.action?.end ?? recipe.targetSeconds, [key]: seconds })
  }
  const summary = source?.observations?.summary ?? ''
  const longSummary = summary.length > SUMMARY_PREVIEW_LENGTH
  const outputSpans: TimelineSpan[] = [...recipe.keep.map(span => ({ ...span, tone: 'keep' as const })), ...recipe.change.map(span => ({ ...span, tone: 'change' as const }))]
  return <section className="goal-initial-analysis" aria-label="Plan">
    <h3>Initial analysis · {source ? `${source.sampleTimes.length} source samples` : 'Brief and settings'}</h3>
    <p className="goal-panel-muted goal-analysis-estimate" title={shortEstimateText(estimate)}>Estimate: {shortEstimateText(estimate)}</p>
    {source && <p className="goal-panel-muted">{source.durationSeconds.toFixed(2)}s · {source.width} × {source.height} · {source.fps.toFixed(2)} fps · {source.hasAudio ? 'Source audio available' : 'No source audio'}</p>}
    {summary && <p className="goal-analysis-summary" data-open={summaryOpen || !longSummary}>{summary}</p>}
    {longSummary && <button type="button" className="goal-link-button" aria-expanded={summaryOpen} onClick={() => setSummaryOpen(open => !open)}>{summaryOpen ? 'Show less' : 'Read all'}</button>}
    {source && <div className="goal-timeline-row">
      <span>Source · {source.cuts.length} cuts · reference {recipe.reference ? ranges([recipe.reference]) : 'not chosen'}</span>
      <Timeline label={`Source, ${source.durationSeconds.toFixed(2)} seconds`} seconds={source.durationSeconds} spans={recipe.reference ? [{ ...recipe.reference, tone: 'reference' }] : []} ticks={source.cuts} />
    </div>}
    <div className="goal-timeline-row">
      <span>Saved recipe: keep {ranges(recipe.keep)} · change {ranges(recipe.change)} · generate {recipe.generatedSeconds}s.</span>
      <Timeline label={`Output, ${recipe.targetSeconds} seconds`} seconds={recipe.targetSeconds} spans={outputSpans} ticks={recipe.outputAssertions ? recipe.checkTimes : []} />
    </div>
    <fieldset disabled={disabled} className="goal-analysis-fields">
      <Segmented label="Structure" name="Remix structure" value={intent.structure} choices={STRUCTURES} onPick={value => update('structure', value)} />
      <Segmented label="Character" name="Character role" value={intent.character} choices={CHARACTERS} onPick={value => update('character', value)} />
      <Segmented label="Sound" name="Remix audio" value={intent.audio} choices={AUDIO} onPick={value => update('audio', value)} />
      <Segmented label="Graphics" name="Source graphics" value={intent.cleanup} choices={CLEANUP} onPick={value => update('cleanup', value)} />
      <div className="goal-analysis-row">
        <label>Action starts<input aria-label="Action start seconds" type="number" min="0" max={recipe.targetSeconds} step="0.01" value={intent.action?.start ?? ''} onChange={event => setBoundary('start', event.target.value)} /></label>
        <label>Action ends<input aria-label="Action end seconds" type="number" min="0" max={recipe.targetSeconds} step="0.01" value={intent.action?.end ?? ''} onChange={event => setBoundary('end', event.target.value)} /></label>
      </div>
      <div className="goal-analysis-row">
        <label className="goal-analysis-switch"><input type="checkbox" checked={intent.noDialogue} onChange={event => update('noDialogue', event.target.checked)} />No new dialogue</label>
        <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.branding} onChange={event => prefer({ branding: event.target.checked })} />Apply saved branding</label>
        <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.reviewImages} onChange={event => prefer({ reviewImages: event.target.checked })} />Stop to review each new image</label>
        <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.autoContinue} onChange={event => prefer({ autoContinue: event.target.checked })} />Offer automatic continuation for this recipe</label>
      </div>
      {preferences.autoContinue && <div className="goal-analysis-row goal-analysis-nested">
        <label>Default allowance (USD)<input aria-label="Default continuation allowance USD" type="number" min="0" step="0.01" value={preferences.allowanceUsd ?? ''} onChange={event => prefer({ allowanceUsd: event.target.value === '' ? null : Math.max(0, Number(event.target.value)) })} /></label>
        {recipe.outputAssertions && <label className="goal-analysis-switch"><input type="checkbox" checked={preferences.semanticChecks} onChange={event => prefer({ semanticChecks: event.target.checked })} />Require sampled visual review before automatic continuation</label>}
      </div>}
    </fieldset>
    {findings.length > 0 && <ul className="goal-short-notes" aria-label="Initial analysis findings">{findings.map((finding, index) => <li key={`${finding.code}:${index}`} data-severity={finding.severity}>{finding.text}</li>)}</ul>}
    {analysis.history.some(entry => entry.failure === 'account') && <p className="goal-panel-warning">An earlier request failed because of account access or credits. Resolve that account issue before another paid request; earlier images are retained.</p>}
    {analysis.history.some(entry => entry.failure === 'request') && <p className="goal-panel-warning">An earlier request failed validation. Check the current request before retrying; this does not require regenerating earlier images.</p>}
    <details className="goal-analysis-details">
      <summary>How this plan runs</summary>
      {recipe.outputAssertions && <p className="goal-panel-muted">File checks run locally when an output is ready. Final visual samples are planned at {recipe.checkTimes.map(time => `${time.toFixed(2)}s`).join(', ')} around shot cuts and the action. A playable file does not prove that it meets the brief.</p>}
      {recipe.outputAssertions && qualityEstimate && <p className="goal-panel-muted">Optional visual review: {qualityEstimate.warnings.join(' ')}</p>}
      {recipe.assembly && <p className="goal-panel-muted">Retain {(recipe.assembly.changeEndFrame - recipe.assembly.changeStartFrame) / recipe.assembly.fps}s of the generated action after review. Assemble {recipe.assembly.totalFrames} frames at {recipe.assembly.fps.toFixed(3)} fps, {recipe.assembly.width} × {recipe.assembly.height}, with straight cuts and the selected sound policy. Generated footage fits inside the source frame. Finishing checks frame count, duration, decoding and current inputs.</p>}
      {source && <p className="goal-panel-muted">Reference: {recipe.reference ? ranges([recipe.reference]) : 'Choose a reference'} · {recipe.cleanupRegions.length} proposed removal regions · {recipe.templateId ? 'Saved branding selected' : 'Default branding'}.</p>}
      <p className="goal-panel-muted">Sound: {choiceName(AUDIO, intent.audio)}.{(intent.audio === 'source' || intent.audio === 'mix') && ` Soundtrack from ${(recipe.soundtrack?.startSeconds ?? 0).toFixed(2)}s maps to the beginning of the final video; trim excess audio and pad a short track with silence.${intent.audio === 'source' ? ' Generated sound is muted.' : ''}`}</p>
      {recipe.branding && <p className="goal-panel-muted">Branding: {preferences.branding ? `${recipe.branding.template?.name ?? recipe.branding.starterId ?? 'Book watermark'} · @${recipe.branding.profile.handle.replace(/^@/, '')}` : 'Off'}. {goalBrandingTitleSlots(recipe.branding, preferences.branding).headline ? 'A burned title is optional; type it or request priced title suggestions.' : 'This look has no burned headline.'} Use current book branding after saving a different look in the graphics editor.</p>}
      {analysis.history.length > 0 && <p className="goal-panel-muted">{analysis.history.length} related earlier attempts · {analysis.history.filter(entry => entry.reusable).length} reviewed images available for reuse. Approving a matching stage reuses its reviewed image. Other completed takes remain reviewable in History.</p>}
      {estimate.warnings.length > 0 && <p className="goal-panel-muted">{estimate.warnings.join(' ')}</p>}
    </details>
    <div className="goal-panel-bar">
      <button type="button" className="goal-panel-button" disabled={disabled} onClick={onSaveDefaults}>Use these defaults for this book</button>
      <button type="button" className="goal-panel-button" disabled={disabled} onClick={onAnalyze}>Refresh analysis</button>
      <button type="button" className="goal-panel-button" disabled={disabled} onClick={onRefreshFinish}>Use current book branding</button>
    </div>
  </section>
}

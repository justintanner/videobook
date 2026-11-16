import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import type { GoalEstimate } from '../../../server/src/goal-store'
import { shortEstimateText } from '@/videobook/goals'

type Props = {
  analysis: GoalRemixAnalysis
  estimate: GoalEstimate
  disabled: boolean
  onChange: (analysis: GoalRemixAnalysis) => void
  onSaveDefaults: () => void
  onAnalyze: () => void
}

const STRUCTURES = ['preserve-source', 'regenerate', 'single-take'] as const
const CHARACTERS = ['insert', 'replace'] as const
const AUDIO = ['source', 'generated', 'mute', 'mix'] as const
const CLEANUP = ['review', 'remove', 'keep'] as const
const structureNames = { 'preserve-source': 'Keep source shots', regenerate: 'Regenerate the video', 'single-take': 'One continuous take' }
const audioNames = { source: 'Original audio', generated: 'Generated sound', mute: 'Muted', mix: 'Mix original and generated' }
const cleanupNames = { review: 'Review source graphics', remove: 'Remove source graphics', keep: 'Keep source graphics' }

function ranges(values: readonly { start: number; end: number }[]): string {
  return values.map(value => `${value.start.toFixed(2)}–${value.end.toFixed(2)}s`).join(', ') || 'None'
}

export function GoalInitialAnalysis({ analysis, estimate, disabled, onChange, onSaveDefaults, onAnalyze }: Props) {
  const { intent, source, recipe, findings } = analysis
  const update = <Key extends keyof GoalRemixAnalysis['intent']>(key: Key, value: GoalRemixAnalysis['intent'][Key]) => {
    onChange({ ...analysis, intent: { ...intent, [key]: value } })
  }
  const setBoundary = (key: 'start' | 'end', value: string) => {
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return
    update('action', { start: intent.action?.start ?? 0, end: intent.action?.end ?? recipe.targetSeconds, [key]: seconds })
  }
  return <details className="goal-initial-analysis" open>
    <summary>Initial analysis · {source ? `${source.sampleTimes.length} source samples` : 'Brief and settings'} · {shortEstimateText(estimate)}</summary>
    {source && <p className="goal-panel-muted">{source.durationSeconds.toFixed(2)}s · {source.width} × {source.height} · {source.fps.toFixed(2)} fps · {source.hasAudio ? 'Source audio available' : 'No source audio'}</p>}
    {source?.observations?.summary && <p>{source.observations.summary}</p>}
    <fieldset disabled={disabled} className="goal-analysis-fields">
      <label>Structure<select aria-label="Remix structure" value={intent.structure} onChange={event => update('structure', STRUCTURES.find(value => value === event.target.value) ?? intent.structure)}>{STRUCTURES.map(value => <option key={value} value={value}>{structureNames[value]}</option>)}</select></label>
      <label>Character<select aria-label="Character role" value={intent.character} onChange={event => update('character', CHARACTERS.find(value => value === event.target.value) ?? intent.character)}>{CHARACTERS.map(value => <option key={value} value={value}>{value === 'insert' ? 'Insert a person' : 'Replace a person'}</option>)}</select></label>
      <label>Sound<select aria-label="Remix audio" value={intent.audio} onChange={event => update('audio', AUDIO.find(value => value === event.target.value) ?? intent.audio)}>{AUDIO.map(value => <option key={value} value={value}>{audioNames[value]}</option>)}</select></label>
      <label>Graphics<select aria-label="Source graphics" value={intent.cleanup} onChange={event => update('cleanup', CLEANUP.find(value => value === event.target.value) ?? intent.cleanup)}>{CLEANUP.map(value => <option key={value} value={value}>{cleanupNames[value]}</option>)}</select></label>
      <label>Action starts<input aria-label="Action start seconds" type="number" min="0" max={recipe.targetSeconds} step="0.01" value={intent.action?.start ?? ''} onChange={event => setBoundary('start', event.target.value)} /></label>
      <label>Action ends<input aria-label="Action end seconds" type="number" min="0" max={recipe.targetSeconds} step="0.01" value={intent.action?.end ?? ''} onChange={event => setBoundary('end', event.target.value)} /></label>
      <label className="goal-analysis-switch"><input type="checkbox" checked={intent.noDialogue} onChange={event => update('noDialogue', event.target.checked)} />No new dialogue</label>
    </fieldset>
    <p className="goal-panel-muted">Saved recipe: keep {ranges(recipe.keep)} · change {ranges(recipe.change)} · generate {recipe.generatedSeconds}s.</p>
    {recipe.assembly && <p className="goal-panel-muted">Retain {(recipe.assembly.changeEndFrame - recipe.assembly.changeStartFrame) / recipe.assembly.fps}s of the generated action after review. Assemble {recipe.assembly.totalFrames} frames at {recipe.assembly.fps.toFixed(3)} fps, {recipe.assembly.width} × {recipe.assembly.height}, with straight cuts and the selected sound policy. Generated footage fits inside the source frame. Finishing checks frame count, duration, decoding and current inputs.</p>}
    {source && <p className="goal-panel-muted">Reference: {recipe.reference ? ranges([recipe.reference]) : 'Choose a reference'} · {recipe.cleanupRegions.length} proposed removal regions · {recipe.templateId ? 'Saved branding selected' : 'Default branding'}.</p>}
    {analysis.history.length > 0 && <p className="goal-panel-muted">{analysis.history.length} related earlier attempts · {analysis.history.filter(entry => entry.reusable).length} reviewed images available for reuse. Approving a matching stage reuses its reviewed image. Other completed takes remain reviewable in Generation history.</p>}
    {analysis.history.some(entry => entry.failure === 'account') && <p className="goal-panel-muted">An earlier request failed because of account access or credits. Resolve that account issue before another paid request; earlier images are retained.</p>}
    {analysis.history.some(entry => entry.failure === 'request') && <p className="goal-panel-muted">An earlier request failed validation. Check the current request before retrying; this does not require regenerating earlier images.</p>}
    {findings.length > 0 && <ul className="goal-short-notes" aria-label="Initial analysis findings">{findings.map((finding, index) => <li key={`${finding.code}:${index}`} data-severity={finding.severity}>{finding.text}</li>)}</ul>}
    {estimate.warnings.length > 0 && <p className="goal-panel-muted">{estimate.warnings.join(' ')}</p>}
    <div className="goal-panel-bar">
      <button type="button" className="goal-panel-button" disabled={disabled} onClick={onSaveDefaults}>Use these defaults for this book</button>
      <button type="button" className="goal-panel-button" disabled={disabled} onClick={onAnalyze}>Refresh analysis</button>
    </div>
  </details>
}

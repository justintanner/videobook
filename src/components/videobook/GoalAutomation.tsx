import { useState } from 'react'
import { goalAutomationTotals } from '../../../server/src/goal-automation-model'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import { shortEstimateText, type ShortGoalSnapshot } from '@/videobook/goals'

type Props = {
  goal: ShortGoalSnapshot
  analysis: GoalRemixAnalysis
  disabled: boolean
  onStart: (args: Record<string, unknown>) => void
  onPause: () => void
}

export function GoalAutomation({ goal, analysis, disabled, onStart, onPause }: Props) {
  const run = goal.automation
  const [allowance, setAllowance] = useState(String(run?.allowanceUsd ?? analysis.preferences.allowanceUsd ?? ''))
  const [audioReviewed, setAudioReviewed] = useState(false)
  const [accountReviewed, setAccountReviewed] = useState(false)
  const totals = run ? goalAutomationTotals(run) : null
  const active = run?.status === 'running'
  const finished = run?.status === 'completed'
  const hasAccountFailure = /account|balance/iu.test(run?.reason ?? '') || analysis.history.some(entry => entry.failure === 'account')
  const needsAudioReview = analysis.intent.noDialogue && ['generated', 'mix'].includes(analysis.intent.audio) && Boolean(goal.stages.videos?.outputs.length)
  const pausedWork = goal.status === 'running' || goal.status === 'planning' || goal.finish?.status === 'running'
  const receipts = (stages: ('replacement' | 'frame' | 'videos')[]) => stages.flatMap(stage => (goal.stages[stage]?.outputs ?? []).flatMap(output => {
    const hash = goal.generationHistory?.find(entry => entry.artifactId === output.artifactId)?.mediaHash
    return hash ? [{ artifact_id: output.artifactId, media_hash: hash }] : []
  }))
  const steps = [
    ...(goal.estimate.planning ? [{ name: 'Initial planning', detail: goal.estimate.planning.usd === 0 ? 'Authored prompts · local · $0' : 'Requested when needed · complete input price unknown · separate from continuation' }] : []),
    { name: 'Source preparation', detail: analysis.source ? analysis.recipe.cleanupReviewedHash ? 'Reviewed source reused · local' : `${analysis.recipe.cleanupMethod} · local preparation and source review required` : 'No source preparation' },
    ...(goal.estimate.replacement ? [{ name: 'Character image', detail: analysis.history.some(entry => entry.reusable && entry.stage === 'replacement') ? 'Reuse reviewed image · $0' : shortEstimateText(goal.estimate.replacement) }] : []),
    { name: 'Action setup', detail: analysis.history.some(entry => entry.reusable && entry.stage === 'frame') ? 'Reuse reviewed image · $0' : shortEstimateText(goal.estimate.frame) },
    ...(goal.estimate.segments ?? [goal.estimate.videos]).map((estimate, index) => ({ name: `Video ${index + 1}`, detail: shortEstimateText(estimate) })),
    { name: 'Output checks', detail: analysis.preferences.semanticChecks ? 'Local files: $0 · sampled visual review: unknown, explicit request required' : 'Local files: $0 · optional visual review is separate' },
    { name: 'Final preview', detail: 'Assembly, saved sound and branding · local · $0 provider cost' },
    { name: 'Optional titles', detail: goal.estimate.title ? shortEstimateText(goal.estimate.title) : 'Unknown · explicit request required' },
  ]
  return <section className="goal-automation" aria-label="Automatic continuation">
    <strong>Automatic continuation{run ? ` · ${run.status}` : ''}</strong>
    <dl className="goal-automation-steps">{steps.map(step => <div key={step.name}><dt>{step.name}</dt><dd>{step.detail}</dd></div>)}</dl>
    <p className="goal-panel-muted">One approval continues through eligible steps to a final preview. Stops for source or action review, {analysis.preferences.reviewImages ? 'new image review, ' : ''}changed inputs, failed checks, account errors, uncertain prices or insufficient allowance. Creative retries: zero.</p>
    {run && <p role="status">{run.step}{run.reason ? ` · ${run.reason}` : ''}</p>}
    {totals && <p className="goal-panel-muted">Automatic spend ${totals.spent.toFixed(4)} · reserved ${totals.reserved.toFixed(4)} · remaining ${totals.remaining.toFixed(4)}{totals.unsettled ? ' · provider cost still unsettled' : ''}</p>}
    {run && run.reservations.length > 0 && <ul className="goal-short-notes">{run.reservations.map(value => <li key={value.id}>{value.stage} {value.index + 1} · {value.status} · estimated ${value.amountUsd.toFixed(4)}{value.spentUsd === null ? '' : ` · recorded $${value.spentUsd.toFixed(4)}`}</li>)}</ul>}
    {goal.estimate.planning && <p className="goal-panel-muted">{goal.estimate.planning.warnings.join(' ')}</p>}
    <p className="goal-panel-muted">This allowance controls estimated submissions, including earlier automatic spend. It is not a provider billing cap. Final charges can exceed estimates. Existing manual work and optional planning, title or visual-review requests are separate. Account balances cannot be guaranteed before a later call.</p>
    <label className="goal-automation-allowance">Total continuation allowance (USD)<input aria-label="Continuation allowance USD" type="number" min="0" step="0.01" value={allowance} disabled={disabled || active} onChange={event => setAllowance(event.target.value)} /></label>
    {needsAudioReview && <label className="goal-analysis-switch"><input type="checkbox" checked={audioReviewed} disabled={disabled || active} onChange={event => setAudioReviewed(event.target.checked)} />I listened to the selected videos and confirmed no new dialogue</label>}
    {hasAccountFailure && <label className="goal-analysis-switch"><input type="checkbox" checked={accountReviewed} disabled={disabled || active} onChange={event => setAccountReviewed(event.target.checked)} />I resolved the account or balance error</label>}
    <div className="goal-panel-bar">{active
      ? <button type="button" disabled={disabled} onClick={onPause}>Pause automatic continuation</button>
      : <button type="button" className="goal-panel-primary" disabled={disabled || pausedWork || goal.status === 'cancelled' || finished || allowance.trim() === '' || !Number.isFinite(Number(allowance)) || Number(allowance) < 0}
        onClick={() => onStart({ allowance_usd: Number(allowance), confirmed: true, reviewed_images: receipts(['replacement', 'frame']), ...(audioReviewed ? { reviewed_audio: receipts(['videos']) } : {}), ...(accountReviewed ? { account_reviewed: true } : {}) })}>{finished ? 'Final preview ready' : run ? 'Resume reviewed recipe' : 'Run reviewed recipe'}</button>}</div>
    {!active && !finished && <p className="goal-panel-muted">Run or resume approves the saved recipe and the currently selected images. New images still stop for review when that setting is enabled.</p>}
  </section>
}

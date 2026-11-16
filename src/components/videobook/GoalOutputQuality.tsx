import type { GoalOutputCheck } from '../../../server/src/goal-quality-model'
import type { GoalEstimate } from '../../../server/src/goal-store'

type Props = {
  name: string
  check: GoalOutputCheck | null
  estimate?: GoalEstimate
  disabled: boolean
  onCheck: (semantic: boolean) => void
}

const labels = { pass: 'Passed', fail: 'Failed', unverified: 'Unverified', 'not-requested': 'Not reviewed' }

export function GoalOutputQuality({ name, check, estimate, disabled, onCheck }: Props) {
  const running = check?.status === 'running'
  const result = check?.result
  const findings = [...(result?.technical.findings ?? []), ...(result?.semantic.findings ?? [])]
  return <section className="goal-output-quality" aria-label={`Output checks for ${name}`}>
    <p><strong>File checks: {running && !check.semantic ? 'Checking…' : result ? labels[result.technical.status] : 'Not checked'}</strong></p>
    <p><strong>Brief compliance: {running && check.semantic ? 'Reviewing samples…' : result ? labels[result.semantic.status] : 'Not reviewed'}</strong></p>
    <p className="goal-panel-muted">Local checks verify readable media and the saved timing, inputs and sound routing. Sampled visual review checks identity, overlays and the requested action; it cannot certify every frame or audio content.</p>
    {result?.semantic.sampleTimes.length ? <p className="goal-panel-muted">Frames reviewed: {result.semantic.sampleTimes.map(time => `${time.toFixed(2)}s`).join(', ')}.</p> : null}
    {findings.length > 0 && <ul aria-label={`${name} check findings`}>{findings.map((finding, index) => <li key={`${finding.code}:${index}`} data-severity={finding.severity}>
      {finding.atSeconds !== null && <strong>{finding.atSeconds.toFixed(2)}s · </strong>}{finding.text}{finding.correction && <p>{finding.correction}</p>}
    </li>)}</ul>}
    {check?.error && <p role="alert">{check.error}</p>}
    {running && <p role="status">Checking the selected {name}…</p>}
    {estimate && !result?.semantic.attempted && <p className="goal-panel-muted">{estimate.warnings.join(' ')}</p>}
    {result?.semantic.attempted && <p className="goal-panel-muted">This paid review is saved. Unchanged media and constraints reuse it without another submission.</p>}
    <div className="goal-panel-bar">
      <button type="button" className="goal-panel-button" disabled={disabled || running} onClick={() => onCheck(false)}>Check file locally</button>
      <button type="button" className="goal-panel-button" disabled={disabled || running || result?.semantic.attempted || result?.technical.status !== 'pass'} onClick={() => onCheck(true)}>Review against brief · paid, price unknown</button>
    </div>
  </section>
}

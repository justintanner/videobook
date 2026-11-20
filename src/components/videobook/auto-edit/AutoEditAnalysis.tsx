import type { AutoEditAnalysisPhase } from '@/videobook/useAutoEdit'

function usdText(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
}

function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

const CONFIDENCE_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

export function AutoEditAnalysis({
  address,
  analysisAvailable,
  analysisPhase,
  disabled,
  onRequestEstimate,
  onConfirmAnalysis,
  onDismissEstimate,
}: {
  address: string
  analysisAvailable: boolean
  analysisPhase: AutoEditAnalysisPhase
  disabled: boolean
  onRequestEstimate: (force: boolean) => void
  onConfirmAnalysis: (force: boolean) => void
  onDismissEstimate: () => void
}) {
  if (!analysisAvailable) {
    return (
      <section className="auto-edit-analysis" aria-label="Find the moment">
        <button type="button" disabled aria-describedby="auto-edit-key-reason">Find the moment</button>
        <p id="auto-edit-key-reason">
          Find the moment needs an OpenAI API key (OPENAI_API_KEY). Add one in Settings, or set the markers yourself on the timeline.
        </p>
      </section>
    )
  }
  if (analysisPhase.step === 'estimating') {
    return (
      <section className="auto-edit-analysis" aria-label="Find the moment">
        <p role="status">Estimating the cost of Find the moment…</p>
      </section>
    )
  }
  if (analysisPhase.step === 'confirm') {
    const cost = `~${usdText(analysisPhase.usd)}`
    return (
      <section className="auto-edit-analysis" data-tone="confirm" aria-label="Find the moment">
        <p>
          {`Sends sampled frames of ${address} to OpenAI in one request. Estimated cost ${cost}.`}
          {analysisPhase.warnings[0] ? ` ${analysisPhase.warnings[0]}` : ''}
        </p>
        <button type="button" className="auto-edit-primary" data-tone="confirm" disabled={disabled} onClick={() => onConfirmAnalysis(analysisPhase.force)}>
          {`Run · ${cost}`}
        </button>
        <button type="button" disabled={disabled} onClick={onDismissEstimate}>Not now</button>
      </section>
    )
  }
  if (analysisPhase.step === 'running') {
    return (
      <section className="auto-edit-analysis" aria-label="Find the moment">
        <span className="auto-edit-progress" aria-hidden="true"><span /></span>
        <p role="status">{`Finding the moment (${analysisPhase.status})… You can keep working or close the sheet.`}</p>
      </section>
    )
  }
  if (analysisPhase.step === 'failed') {
    return (
      <section className="auto-edit-analysis" data-tone="failed" aria-label="Find the moment">
        <p role="alert">{`Find the moment failed: ${asSentence(analysisPhase.message)} Your markers are unchanged.`}</p>
        <button type="button" disabled={disabled} onClick={() => onRequestEstimate(false)}>Try again</button>
      </section>
    )
  }
  if (analysisPhase.step === 'ready') {
    return (
      <section className="auto-edit-analysis" data-confidence={analysisPhase.confidence} aria-label="Find the moment">
        <span className="auto-edit-confidence">{CONFIDENCE_LABEL[analysisPhase.confidence]}</span>
        <p>
          {analysisPhase.summary}
          {analysisPhase.confidence === 'low' ? ' Check the peak and the subject before you render.' : ' Fine-tune any marker on the timeline.'}
        </p>
        <button type="button" disabled={disabled} onClick={() => onRequestEstimate(true)}>Re-analyze</button>
      </section>
    )
  }
  return (
    <section className="auto-edit-analysis" aria-label="Find the moment">
      <button type="button" className="auto-edit-primary" disabled={disabled} onClick={() => onRequestEstimate(false)}>Find the moment</button>
      <p>Places the hook and the moment for you in one paid call; you see the cost first. Or set the markers yourself on the timeline.</p>
    </section>
  )
}

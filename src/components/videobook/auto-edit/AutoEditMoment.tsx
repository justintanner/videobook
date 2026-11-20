import { secondsToFrame } from '../../../../server/src/auto-edit/plan'
import type { AutoEditAnchors, AutoEditSections } from '../../../../server/src/auto-edit/style'
import type { AutoEditAnalysisPhase, AutoEditSource } from '@/videobook/useAutoEdit'

const SECTION_SWITCHES: ReadonlyArray<{ key: keyof AutoEditSections; label: string }> = [
  { key: 'coldOpen', label: 'Cold open' },
  { key: 'replays', label: 'Replays' },
  { key: 'pushIn', label: 'Push-in' },
  { key: 'crash', label: 'Crash' },
  { key: 'sounds', label: 'Sounds' },
]

export type AnchorFieldKey =
  | 'hook.start'
  | 'hook.end'
  | 'moment.start'
  | 'moment.peak'
  | 'moment.end'

const ANCHOR_ROWS: ReadonlyArray<{ key: AnchorFieldKey; label: string }> = [
  { key: 'hook.start', label: 'Hook start' },
  { key: 'hook.end', label: 'Hook end' },
  { key: 'moment.start', label: 'Moment start' },
  { key: 'moment.peak', label: 'Moment peak' },
  { key: 'moment.end', label: 'Moment end' },
]

function anchorSeconds(anchors: AutoEditAnchors, key: AnchorFieldKey): number {
  if (key === 'hook.start') return anchors.hook?.start ?? anchors.keep.start
  if (key === 'hook.end') return anchors.hook?.end ?? Math.min(anchors.keep.end, anchors.keep.start + 2.5)
  if (key === 'moment.start') return anchors.moment.start
  if (key === 'moment.peak') return anchors.moment.peak
  return anchors.moment.end
}

function usdText(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`
}

export function AutoEditMoment({
  source,
  anchors,
  sections,
  changes,
  focusAnchor,
  analysisAvailable,
  analysisPhase,
  disabled,
  onSectionChange,
  onSetToPlayhead,
  onNudgeAnchor,
  onSelectFocusAnchor,
  onRequestEstimate,
  onConfirmAnalysis,
  onDismissEstimate,
}: {
  source: AutoEditSource
  anchors: AutoEditAnchors
  sections: AutoEditSections
  changes: readonly string[]
  focusAnchor: 'start' | 'peak' | 'end'
  analysisAvailable: boolean
  analysisPhase: AutoEditAnalysisPhase
  disabled: boolean
  onSectionChange: (key: keyof AutoEditSections, enabled: boolean) => void
  onSetToPlayhead: (key: AnchorFieldKey) => void
  onNudgeAnchor: (key: AnchorFieldKey, deltaFrames: number) => void
  onSelectFocusAnchor: (which: 'start' | 'peak' | 'end') => void
  onRequestEstimate: (force: boolean) => void
  onConfirmAnalysis: (force: boolean) => void
  onDismissEstimate: () => void
}) {
  return (
    <div className="auto-edit-controls-pane">
      <div className="auto-edit-switches" role="group" aria-label="Sections">
        {SECTION_SWITCHES.map((item) => (
          <label key={item.key} className="auto-edit-switch">
            <input
              type="checkbox"
              role="switch"
              checked={sections[item.key]}
              disabled={disabled}
              onChange={(event) => onSectionChange(item.key, event.target.checked)}
            />
            <span>{item.label}</span>
          </label>
        ))}
      </div>

      <section className="auto-edit-analyze-box" aria-label="Analysis">
        {!analysisAvailable && (
          <>
            <button type="button" disabled aria-describedby="auto-edit-key-reason">Find the moment</button>
            <p id="auto-edit-key-reason" className="auto-edit-muted">
              Find the moment needs an OpenAI API key (OPENAI_API_KEY). Place anchors by hand or configure a key in Settings.
            </p>
          </>
        )}
        {analysisAvailable && analysisPhase.step === 'idle' && (
          <div className="auto-edit-analyze-actions">
            <button type="button" disabled={disabled} onClick={() => onRequestEstimate(false)}>Find the moment</button>
          </div>
        )}
        {analysisAvailable && analysisPhase.step === 'estimating' && (
          <p className="auto-edit-muted" role="status">Estimating analysis cost…</p>
        )}
        {analysisAvailable && analysisPhase.step === 'confirm' && (
          <>
            <p className="auto-edit-analysis-summary">
              {`Estimated cost: ~${usdText(analysisPhase.usd)}`}
              {analysisPhase.warnings[0] ? ` · ${analysisPhase.warnings[0]}` : ''}
            </p>
            <div className="auto-edit-analyze-actions">
              <button type="button" disabled={disabled} onClick={() => onConfirmAnalysis(analysisPhase.force)}>
                {`Confirm Find the moment (~${usdText(analysisPhase.usd)})`}
              </button>
              <button type="button" disabled={disabled} onClick={onDismissEstimate}>Dismiss estimate</button>
            </div>
          </>
        )}
        {analysisAvailable && analysisPhase.step === 'running' && (
          <p className="auto-edit-muted" role="status">
            {`Finding the moment (${analysisPhase.status})… You can still adjust switches or close with Escape.`}
          </p>
        )}
        {analysisAvailable && analysisPhase.step === 'failed' && (
          <>
            <p className="auto-edit-alert" role="alert">{analysisPhase.message}</p>
            <div className="auto-edit-analyze-actions">
              <button type="button" disabled={disabled} onClick={() => onRequestEstimate(false)}>Find the moment</button>
            </div>
          </>
        )}
        {analysisAvailable && analysisPhase.step === 'ready' && (
          <>
            <p className="auto-edit-analysis-summary">
              <strong>{`${analysisPhase.confidence} confidence:`}</strong>{' '}
              {analysisPhase.summary}
            </p>
            <div className="auto-edit-analyze-actions">
              <button type="button" disabled={disabled} onClick={() => onRequestEstimate(true)}>Re-analyze</button>
            </div>
          </>
        )}
      </section>

      <div className="auto-edit-anchor-list">
        {ANCHOR_ROWS.map((row) => {
          const secs = anchorSeconds(anchors, row.key)
          const frame = secondsToFrame(secs, source.fps)
          return (
            <div key={row.key} className="auto-edit-anchor-row" role="group" aria-label={row.label}>
              <div className="auto-edit-anchor-meta">
                <strong>{row.label}</strong>
                <span>{`${secs.toFixed(2)}s · frame ${frame}`}</span>
              </div>
              <div className="auto-edit-anchor-buttons">
                <button type="button" disabled={disabled} onClick={() => onNudgeAnchor(row.key, -1)}>-1 frame</button>
                <button type="button" disabled={disabled} onClick={() => onNudgeAnchor(row.key, 1)}>+1 frame</button>
                <button type="button" disabled={disabled} onClick={() => onSetToPlayhead(row.key)}>Set to playhead</button>
              </div>
            </div>
          )
        })}
      </div>

      <section aria-label="Subject position">
        <div className="auto-edit-focus-row" role="group" aria-label="Subject position anchor">
          {(['start', 'peak', 'end'] as const).map((which) => (
            <button
              key={which}
              type="button"
              disabled={disabled}
              aria-pressed={focusAnchor === which}
              onClick={() => onSelectFocusAnchor(which)}
            >
              {`Focus ${which} (${Math.round(anchors.focus[which].x * 100)}%, ${Math.round(anchors.focus[which].y * 100)}%)`}
            </button>
          ))}
        </div>
        <p className="auto-edit-muted">Click the paused picture to place the subject for the selected anchor.</p>
      </section>

      {changes.length > 0 && (
        <ul className="auto-edit-notices" role="status" aria-label="Anchor notices">
          {changes.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

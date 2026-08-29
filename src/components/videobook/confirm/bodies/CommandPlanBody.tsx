import { Ban, TriangleAlert } from 'lucide-react'
import type { CommandPlan } from '@/videobook/command-plan'

export interface CommandPlanStagePreview {
  valid: boolean
  diff: {
    changedClipIds: readonly string[]
    beforeDurationFrames: number
    afterDurationFrames: number
  }
  warnings: readonly { message: string }[]
  conflicts: readonly { message: string }[]
}

export function CommandPlanBody({
  busy,
  onToggleSuggestion,
  plan,
  previews,
}: {
  busy: boolean
  onToggleSuggestion: (suggestionId: string) => void
  plan: CommandPlan
  previews: Record<string, CommandPlanStagePreview>
}) {
  return (
    <div className="confirm-plan">
      <div className="confirm-plan-context">
        <p>{plan.confirmation.reason}</p>
        {plan.suggestions && (
          <fieldset className="confirm-plan-suggestions">
            <legend>Include suggestions</legend>
            {plan.suggestions.map((suggestion) => (
              <label key={suggestion.suggestionId}>
                <input
                  type="checkbox"
                  checked={suggestion.included}
                  disabled={busy}
                  onChange={() => onToggleSuggestion(suggestion.suggestionId)}
                />
                <span>
                  <strong>{suggestion.label}</strong>
                  {suggestion.detail && <small>{suggestion.detail}</small>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <ol className="confirm-stages" aria-label="Planned stages">
        {plan.stages.map((stage) => {
          const preview = stage.kind === 'edit' ? previews[stage.stageId] : undefined
          return (
            <li key={stage.stageId}>
              <span>{stage.kind.toUpperCase()}</span>
              <strong>{stage.summary}</strong>
              {preview && (
                <>
                  <small>
                    {preview.diff.changedClipIds.length} clips · duration {preview.diff.beforeDurationFrames} → {preview.diff.afterDurationFrames} frames
                  </small>
                  {preview.warnings.map((warning, index) => (
                    <p className="confirm-stage-warning" key={`${stage.stageId}:warning:${index}`}>
                      <TriangleAlert size={11} aria-hidden="true" />
                      {warning.message}
                    </p>
                  ))}
                  {preview.conflicts.map((conflict, index) => (
                    <p className="confirm-stage-conflict" key={`${stage.stageId}:conflict:${index}`}>
                      <Ban size={11} aria-hidden="true" />
                      {conflict.message}
                    </p>
                  ))}
                </>
              )}
              {stage.kind === 'queued' && (
                <small>
                  {stage.provider && stage.model
                    ? `${stage.provider} · ${stage.model}`
                    : stage.tool}
                  {stage.estimatedCostUsd !== undefined
                    ? ` · estimated $${stage.estimatedCostUsd.toFixed(4)}`
                    : stage.estimateUnavailable
                      ? ' · cost estimate unavailable'
                      : ''}
                </small>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

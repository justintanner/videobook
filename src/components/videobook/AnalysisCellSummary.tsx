import { Braces } from 'lucide-react'
import {
  formatMediaTime,
  type NotebookAnalysisInfo,
} from '@/videobook/notebook-cell-presentation'
import { RichJson } from './RichJson'

export function AnalysisCellSummary({
  analysisInfo,
  fallbackShotCount = null,
  fallbackSourceDurationSeconds = null,
}: {
  analysisInfo: NotebookAnalysisInfo | null
  fallbackShotCount?: number | null
  fallbackSourceDurationSeconds?: number | null
}) {
  const shotCount = analysisInfo?.shots.length
    ?? fallbackShotCount
    ?? 0
  const duration = analysisInfo?.sourceDurationSeconds
    ?? fallbackSourceDurationSeconds
  const shots = analysisInfo?.shots.slice(0, 3) ?? []
  const overflow = Math.max(0, shotCount - shots.length)
  const outputJson = analysisInfo?.outputJson

  return (
    <div className="cell-copy cell-copy-analysis">
      <div className="analysis-cell-summary">
        <strong>{shotCount > 0 ? `${shotCount} shots` : 'Analysis pending'}</strong>
        {duration !== null && (
          <span>{formatMediaTime(duration)}</span>
        )}
      </div>
      {shots.length > 0 && (
        <ol className="analysis-cell-shots">
          {shots.map((shot) => (
            <li key={shot.ordinal}>
              <span>{shot.label}</span>
              <time>
                {formatMediaTime(shot.startSeconds)}–{formatMediaTime(shot.endSeconds)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {overflow > 0 && (
        <span className="analysis-cell-overflow">+{overflow} more</span>
      )}
      {outputJson !== null && outputJson !== undefined && (
        <details className="analysis-cell-output-json nodrag nowheel">
          <summary>
            <Braces size={11} aria-hidden="true" />
            Output JSON
          </summary>
          <div
            className="analysis-cell-output-json-scroll"
            tabIndex={0}
          >
            <RichJson
              value={outputJson}
              ariaLabel="Analysis output JSON"
            />
          </div>
        </details>
      )}
    </div>
  )
}

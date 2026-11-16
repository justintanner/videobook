import { useState } from 'react'
import type { GoalHistoryEntry } from '../../../server/src/goal-generation-history'
import type { AssetRecord } from '@/videobook/workspace-responses'

type Props = {
  entries: GoalHistoryEntry[]
  revision: number
  disabled: boolean
  resolveAsset: (artifactId: string) => AssetRecord | null
  onAdopt: (entry: GoalHistoryEntry) => void
}

const names = { replacement: 'Character', frame: 'Action setup', videos: 'Video', storyboards: 'Storyboard' }

export function GoalTakeHistory({ entries, revision, disabled, resolveAsset, onAdopt }: Props) {
  const [reviewed, setReviewed] = useState<string | null>(null)
  if (!entries.length) return null
  return <details className="goal-take-history">
    <summary>Generation history · {entries.length} attempts</summary>
    {entries.map(entry => {
      const key = `${entry.generationId ?? `${entry.chainId}:${entry.stepId}`}:${entry.artifactId}:${entry.mediaHash}:${revision}`
      const asset = entry.artifactId ? resolveAsset(entry.artifactId) : null
      const settled = ['completed', 'cancelled', 'interrupted'].includes(entry.status)
      return <details key={key} className="goal-take-entry">
        <summary>{names[entry.stage]} {entry.index + 1} · {entry.status}{entry.selected ? ' · selected in original goal' : ''}{entry.review ? ' · reviewed' : ''}</summary>
        {asset?.type === 'video' && asset.mediaUrl ? <video controls preload="metadata" src={asset.mediaUrl} aria-label="Review historical take" />
          : (asset?.mediaUrl ?? asset?.thumbnailUrl) && <img src={asset?.mediaUrl ?? asset?.thumbnailUrl ?? ''} alt="Historical generation" />}
        <p className="goal-panel-muted">{entry.actualModel ?? 'Model unavailable'} · {entry.costUsd === null ? 'Settled cost unavailable' : `$${entry.costUsd.toFixed(4)}`} · intent revision {entry.revision ?? 'unrecorded'}</p>
        <p className="goal-take-prompt">{entry.prompt || 'Prompt unavailable'}</p>
        <p className="goal-panel-muted">Inputs: {entry.references.map(reference => `${reference.role} ${reference.index + 1}`).join(', ') || 'Not recorded'}. {entry.lineage ? 'Source and input versions are checked when adopting.' : 'This older request has incomplete input-version evidence.'}</p>
        {entry.error && <p role="status">{entry.error}</p>}
        {entry.mediaHash && settled && <>
          <label className="goal-analysis-switch"><input type="checkbox" disabled={disabled} checked={reviewed === key} onChange={event => setReviewed(event.target.checked ? key : null)} />I reviewed this take for the current brief</label>
          <button type="button" className="goal-panel-button" disabled={disabled || reviewed !== key} onClick={() => onAdopt(entry)}>Use reviewed take</button>
        </>}
      </details>
    })}
  </details>
}

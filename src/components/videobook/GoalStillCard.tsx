import { useState } from 'react'
import type { GoalStillStage } from '../../../server/src/goal-plan'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { goalStillStale, goalStillVersions, type GoalSnapshot } from '@/videobook/goals'
import { GoalPromptInput } from './GoalPromptInput'

type AssetResolver = (artifactId: string) => AssetRecord | null

export function GoalMedia({ artifactId, cellId, label, resolveAsset, onOpen, fullResolution = false }: {
  artifactId: string
  cellId: string | null
  label: string
  resolveAsset: AssetResolver
  onOpen: (cellId: string) => void
  fullResolution?: boolean
}) {
  const asset = resolveAsset(artifactId)
  const url = fullResolution ? asset?.mediaUrl ?? asset?.thumbnailUrl : asset?.thumbnailUrl ?? asset?.mediaUrl
  return <button type="button" className="goal-media" disabled={!cellId} onClick={() => { if (cellId) onOpen(cellId) }} aria-label={`Open ${label}`}>
    {url ? <img src={url} alt={label} /> : <span className="goal-media-pending">Preview pending</span>}
    <span>{label}</span>
  </button>
}

export function GoalStillCard({ goal, stage, index, prompt, disabled, canGenerate, resolveAsset, onOpen, onPromptChange, onRegenerate, onRevise, onSelect }: {
  goal: GoalSnapshot
  stage: GoalStillStage
  index: number
  prompt: string
  disabled: boolean
  canGenerate: boolean
  resolveAsset: AssetResolver
  onOpen: (cellId: string) => void
  onPromptChange: (value: string) => void
  onRegenerate: () => void
  onRevise: (feedback: string) => void
  onSelect: (artifactId: string) => void
}) {
  const [feedback, setFeedback] = useState('')
  const output = goal.stages[stage]?.outputs.find(item => item.index === index)
  if (!output) return null
  const count = goal.plan?.shots.length ?? 1
  const ending = stage === 'storyboards' && index >= count
  const storyboard = stage === 'storyboards' && !ending
  const label = stage === 'frame' ? 'Full frame' : `${ending ? 'Ending frame' : 'Storyboard'} ${index % count + 1}`
  const versions = goalStillVersions(goal, stage, index)
  const stale = goalStillStale(goal, stage, index)
  const estimate = stage === 'frame' ? goal.estimate.frame.usd : goal.estimate.still.usd
  const validFeedback = Boolean(feedback.trim()) && !feedback.includes('@')
  const revise = () => { if (!disabled && canGenerate && validFeedback) onRevise(feedback.trim()) }
  return <section className="goal-still-card" aria-label={label} data-stage={stage} data-storyboard={storyboard}>
    <GoalMedia artifactId={output.artifactId} cellId={output.cellId} label={label} resolveAsset={resolveAsset} onOpen={onOpen} fullResolution={storyboard} />
    <div className="goal-still-tools">
      {storyboard && !stale && <p className="goal-panel-muted">Read left to right, then top to bottom.</p>}
      <div className="goal-versions" aria-label={`${label} versions`}>
        {versions.map((version, position) => {
          const asset = version.artifactId ? resolveAsset(version.artifactId) : null
          const url = asset?.thumbnailUrl ?? asset?.mediaUrl
          const name = `v${versions.length - position}`
          return <button key={`${version.chainId}:${version.stepId}`} type="button" className="goal-version" aria-label={`${label} ${name}`} aria-pressed={version.current} title={version.feedback ?? 'Fresh generation'} disabled={disabled || !version.artifactId || version.status !== 'completed'} onClick={() => { if (version.artifactId) onSelect(version.artifactId) }}>
            {url && <img src={url} alt="" />}<span>{name}</span>
          </button>
        })}
      </div>
      {stale && <p className="goal-panel-warning" role="status">{stale}</p>}
      <div className="goal-revise-row">
        <input aria-label={`What should change in ${label}?`} placeholder="What should change?" value={feedback} maxLength={300} disabled={disabled} onChange={event => setFeedback(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          revise()
        }} />
        <button type="button" className="goal-panel-button" disabled={disabled || !canGenerate || !validFeedback} onClick={revise}>Revise{estimate === null ? '' : ` · $${estimate.toFixed(2)}`}</button>
        <button type="button" className="goal-panel-button" disabled={disabled || !canGenerate} onClick={onRegenerate}>Regenerate</button>
      </div>
      {feedback.includes('@') && <p className="goal-panel-muted">Describe the change without @ references.</p>}
      <details className="goal-disclosure">
        <summary>Prompt</summary>
        <GoalPromptInput label={stage === 'frame' ? 'Full frame prompt' : ending ? 'Ending frame prompt' : 'Storyboard prompt'} name={stage === 'frame' ? 'Full frame prompt' : `Shot ${index % count + 1} ${ending ? 'ending frame' : 'storyboard'} prompt`} budget={stage === 'frame' ? 'frame' : ending ? 'ending' : 'storyboard'} value={prompt} disabled={disabled} onChange={onPromptChange} />
        <button type="button" className="goal-panel-button" disabled={disabled || !canGenerate} onClick={onRegenerate}>Save and regenerate</button>
      </details>
    </div>
  </section>
}

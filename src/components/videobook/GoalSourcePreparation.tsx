import { useState } from 'react'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import { cleanupFrameCount, validateCleanupRegions, type CleanupMethod, type CleanupRegion } from '../../../server/src/video-cleanup/model'
import type { ShortGoalSnapshot } from '@/videobook/goals'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { CleanupRegionEditor } from './VideoCleanupSheet'

type PreparationInput = { confirmed: true; regions: CleanupRegion[]; method: CleanupMethod; artifactId?: string; mediaHash?: string }
type Props = {
  analysis: GoalRemixAnalysis
  preparation: ShortGoalSnapshot['preparation']
  disabled: boolean
  resolveAsset: (artifactId: string) => AssetRecord | null
  onPrepare: (input: PreparationInput) => void
  onReview: (artifactId: string, mediaHash: string) => void
}

export function GoalSourcePreparation({ analysis, preparation, disabled, resolveAsset, onPrepare, onReview }: Props) {
  const { source, recipe } = analysis
  const [regions, setRegions] = useState(recipe.cleanupRegions)
  const [method, setMethod] = useState<CleanupMethod>(recipe.cleanupMethod)
  const [candidateId, setCandidateId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  if (!source || analysis.intent.cleanup === 'keep') return null
  const candidate = recipe.cleanupCandidates.find(item => item.artifactId === candidateId)
  const running = preparation?.status === 'running'
  const busy = disabled || running
  const ready = recipe.cleanupReviewedHash !== null && recipe.cleanupReviewedHash === recipe.preparedMediaHash
  let regionError: string | null = null
  try { validateCleanupRegions(regions, source.durationSeconds) } catch { regionError = 'Choose at least one region, with valid positions and times.' }
  const modelMissing = method === 'lama' && !recipe.cleanupModelReady && !candidate
  const changeRegions = (value: CleanupRegion[]) => { setRegions(value); setConfirmed(false); setCandidateId('') }
  const choose = (id: string) => {
    setCandidateId(id)
    setConfirmed(false)
    const next = recipe.cleanupCandidates.find(item => item.artifactId === id)
    if (next) { setRegions(next.regions); setMethod(next.method) }
  }
  const preparedUrl = recipe.preparedArtifactId ? resolveAsset(recipe.preparedArtifactId)?.mediaUrl : null
  const progress = preparation?.progress
  const observations = source.observations?.overlays ?? []
  return <details className="goal-source-preparation" open={!ready}>
    <summary>{ready ? 'Reviewed source ready' : 'Prepare the source graphics'}</summary>
    <p>Keep physical signs and printing. Only the reviewed regions are removed. Watch the cleaned video for leftover graphics and visible fill defects before using it.</p>
    {observations.length > 0 && <ul aria-label="Source graphics observations">{observations.map(item => <li key={`${item.kind}:${item.start}:${item.end}:${item.x}:${item.y}:${item.description}`}>{item.description} · {item.kind === 'physical' ? 'Physical scene detail — keep' : item.kind === 'uncertain' ? 'Uncertain — review' : 'Proposed overlay'} · {item.start.toFixed(2)}–{item.end.toFixed(2)}s</li>)}</ul>}
    <CleanupRegionEditor source={{ ...source, duration_seconds: source.durationSeconds }} mediaUrl={resolveAsset(source.artifactId)?.mediaUrl ?? null}
      regions={regions} disabled={busy} onChange={changeRegions} controls={<>
        {recipe.cleanupCandidates.length > 0 && <label>Existing cleaned copy<select aria-label="Existing cleaned copy" value={candidateId} disabled={busy} onChange={event => choose(event.target.value)}>
          <option value="">Prepare these regions</option>
          {recipe.cleanupCandidates.map((item, index) => <option key={item.artifactId} value={item.artifactId}>Cleaned copy {index + 1} · {item.method === 'lama' ? 'Local AI' : 'Fast fill'} · {item.regions.length} regions{item.reviewed ? ' · reviewed' : ''}</option>)}
        </select></label>}
        <label>Removal method<select aria-label="Goal removal method" value={method} disabled={busy} onChange={event => { setMethod(event.target.value === 'fill' ? 'fill' : 'lama'); setCandidateId(''); setConfirmed(false) }}>
          <option value="lama">Local AI · LaMa</option><option value="fill">Fast fill · simple backgrounds</option>
        </select></label>
        <p>{cleanupFrameCount(regions, source.fps)} frames need removal. {candidate ? 'This existing copy will be checked and reused.' : method === 'lama' ? 'Local AI can take several minutes or longer. Progress and Stop remain available.' : 'Fast fill suits small overlays on plain backgrounds.'}</p>
        {modelMissing && <p className="goal-panel-warning">Download the local model in Remove graphics, choose Fast fill, or select an existing cleaned copy.</p>}
      </>} />
    <label className="goal-analysis-switch"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed the regions and kept physical scene details.</label>
    <button type="button" className="goal-panel-button" disabled={busy || !confirmed || Boolean(regionError) || modelMissing} onClick={() => onPrepare({ confirmed: true, regions, method, ...(candidate ? { artifactId: candidate.artifactId, mediaHash: candidate.mediaHash } : {}) })}>{candidate ? 'Use existing cleaned copy' : 'Prepare cleaned source'}</button>
    {regionError && <p className="goal-panel-muted">{regionError} If no removal is needed, choose Keep source graphics above.</p>}
    {running && <p role="status">{progress ? `Preparing source · ${progress.completedFrames}/${progress.totalFrames} frames · ${Math.round(progress.elapsedSeconds)}s elapsed` : 'Preparing source references…'}</p>}
    {preparation?.status === 'failed' && <p role="alert">{preparation.error}</p>}
    {recipe.preparedArtifactId && <div className="goal-prepared-preview">
      {preparedUrl ? <video controls playsInline preload="metadata" src={preparedUrl} aria-label="Prepared source video" /> : <p>Loading prepared source preview…</p>}
      <p>{ready ? 'This source has been reviewed and will feed both the image and video references.' : 'Duration, dimensions, frame rate, decoding and source audio passed. Review the removal and any flicker across the whole clip.'}</p>
      {!ready && <>
        <label className="goal-analysis-switch"><input type="checkbox" checked={reviewed} disabled={busy || !preparedUrl} onChange={event => setReviewed(event.target.checked)} />The graphics are removed, the fill looks acceptable, and the sound is intact.</label>
        <button type="button" className="goal-panel-primary" disabled={busy || !reviewed || !recipe.preparedMediaHash} onClick={() => onReview(recipe.preparedArtifactId!, recipe.preparedMediaHash!)}>Use reviewed source</button>
      </>}
    </div>}
  </details>
}

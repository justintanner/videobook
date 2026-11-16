import { useRef, useState } from 'react'
import type { GoalRemixAnalysis } from '../../../server/src/goal-remix-model'
import type { GoalActionWindow as ActionWindow } from '../../../server/src/goal-store'
import type { AssetRecord } from '@/videobook/workspace-responses'

type Props = {
  analysis: GoalRemixAnalysis
  asset: AssetRecord
  window: ActionWindow | null
  reviewed: boolean
  disabled: boolean
  onReview: (startSeconds: number) => void
}

export function GoalActionWindow({ analysis, asset, window, reviewed, disabled, onReview }: Props) {
  const assembly = analysis.recipe.assembly!
  const video = useRef<HTMLVideoElement>(null)
  const playingWindow = useRef(false)
  const [start, setStart] = useState(window?.artifactId === asset.artifactId ? window.startFrame / assembly.fps : 0)
  const [confirmed, setConfirmed] = useState(false)
  const length = (assembly.changeEndFrame - assembly.changeStartFrame) / assembly.fps
  const aligned = Math.round(start * assembly.fps) / assembly.fps
  const end = aligned + length
  const fits = asset.duration === null || end <= asset.duration + 0.0001
  const unchanged = reviewed && window?.startFrame === Math.round(start * assembly.fps)
  return <fieldset className="goal-action-window" disabled={disabled}>
    <legend>Retained action window</legend>
    {asset.mediaUrl && <video ref={video} className="goal-video-preview" aria-label="Generated action for review" src={asset.mediaUrl} controls playsInline preload="metadata"
      onTimeUpdate={event => { if (playingWindow.current && event.currentTarget.currentTime >= end) { event.currentTarget.pause(); playingWindow.current = false } }} />}
    <p>Keep {aligned.toFixed(3)}–{end.toFixed(3)}s of this take for final-video {analysis.recipe.change[0]?.start.toFixed(3)}–{analysis.recipe.change[0]?.end.toFixed(3)}s. Check that the full action and payoff fit.</p>
    <label>Start in generated clip<input aria-label="Retained action start seconds" type="number" min="0" step={1 / assembly.fps} value={start}
      onChange={event => { setStart(Number(event.target.value)); setConfirmed(false) }} /></label>
    <button type="button" className="goal-panel-button" disabled={!fits || !asset.mediaUrl} onClick={() => {
      if (!video.current) return
      video.current.currentTime = aligned
      playingWindow.current = true
      void video.current.play().catch(() => undefined)
    }}>Play retained window</button>
    {!fits && <p role="alert">This window runs past the clip. Choose an earlier start or regenerate the action.</p>}
    {unchanged ? <p role="status">Action window reviewed.</p> : <>
      <label className="goal-analysis-switch"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />The whole action and payoff are inside this window</label>
      <button type="button" className="goal-panel-button" disabled={!confirmed || !fits || !asset.objectHash || start < 0} onClick={() => onReview(aligned)}>Use this action window</button>
    </>}
  </fieldset>
}

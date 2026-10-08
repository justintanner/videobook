import { useState, type AnimationEvent } from 'react'
import { Flag } from 'lucide-react'
import {
  goalProgress,
  goalStatusLine,
  goalTileView,
  goalWake,
  goalWakeKey,
  type GoalSnapshot,
  type GoalWake,
} from '@/videobook/goals'
import { useElapsedSeconds } from '@/videobook/use-elapsed-seconds'
import './GoalComposerStatus.css'

type GoalComposerStatusProps = {
  goal: GoalSnapshot
  disabled?: boolean
  onOpen: () => void
}

type SeenGoal = {
  key: string
  goal: GoalSnapshot
}

function GoalStatusText({ text, short }: { text: string; short: string }) {
  return (
    <>
      <span className="goal-status-long">{text}</span>
      <span className="goal-status-short">{short}</span>
    </>
  )
}

export function GoalComposerStatus({ goal, disabled = false, onOpen }: GoalComposerStatusProps) {
  const progress = goalProgress(goal)
  const generatingSince = progress.active?.state === 'generating'
    ? progress.active.startedAt
    : null
  const elapsed = useElapsedSeconds(generatingSince)
  const line = goalStatusLine(goal, elapsed)
  const { styleLabel } = goalTileView(goal, goal.plan, undefined)
  const key = goalWakeKey(goal)
  const [seen, setSeen] = useState<SeenGoal>({ key, goal })
  const [wake, setWake] = useState<GoalWake | null>(null)
  if (seen.key !== key) {
    setSeen({ key, goal })
    setWake(goalWake(seen.goal, goal))
  }
  const finishWake = (event: AnimationEvent<HTMLSpanElement>) => {
    if (event.animationName === 'goal-status-roll-in') setWake(null)
  }
  const showTicks = progress.total > 0 && progress.phase !== 'planning' && progress.phase !== 'review'

  return (
    <>
      <div
        className="goal-status"
        data-tone={line.tone}
        data-wake={wake?.tone}
      >
        <button
          type="button"
          className="goal-status-button"
          disabled={disabled}
          aria-label={`Goal ${goal.address ?? ''}${styleLabel ? ` · ${styleLabel}` : ''}: ${line.text}. Open the goal panel`}
          title={goal.plan?.title ?? goal.brief}
          onClick={onOpen}
        >
          <Flag size={13} aria-hidden="true" className="goal-status-flag" />
          <span className="goal-status-kind" aria-hidden="true">Goal</span>
          {styleLabel && <span className="goal-status-style" aria-hidden="true">{styleLabel}</span>}
          <span className="goal-status-text" aria-hidden="true">
            {wake ? (
              <>
                <span key={`in:${wake.id}`} className="goal-status-roll goal-status-roll-in" onAnimationEnd={finishWake}>
                  <GoalStatusText text={line.text} short={line.short} />
                </span>
                <span key={`out:${wake.id}`} className="goal-status-roll goal-status-roll-out">{wake.from}</span>
              </>
            ) : (
              <span className="goal-status-roll">
                <GoalStatusText text={line.text} short={line.short} />
              </span>
            )}
          </span>
          {line.busy && (
            <span className="goal-status-spinner" aria-hidden="true" />
          )}
          {showTicks && (
            <span className="goal-status-ticks" aria-hidden="true">
              {progress.shots.map((shot) => <i key={shot.index} data-state={shot.state} />)}
            </span>
          )}
          {line.action && <span className="goal-status-action" aria-hidden="true">{line.action}</span>}
        </button>
        <span className="sr-only" role="status">{line.announce}</span>
      </div>
      {wake && <span key={`scan:${wake.id}`} className="command-transmit-scan goal-status-scan" aria-hidden="true" />}
    </>
  )
}

import { SHORT_FINISH_TITLE_LIMITS, type ShortFinishTitle } from '../../../server/src/goal-short-plan'
import { shortEstimateText, type ShortGoalSnapshot } from '@/videobook/goals'

type GoalFinishTitleProps = {
  headline: string
  secondary: string
  slots: ShortGoalSnapshot['titleSlots']
  estimate: ShortGoalSnapshot['estimate']['title']
  options: readonly ShortFinishTitle[]
  issue: string | null
  disabled: boolean
  onHeadline: (value: string) => void
  onSecondary: (value: string) => void
  onWrite: () => void
}

const NO_HEADLINE = 'The saved TikTok watermark template has no headline, so Finish burns the handle alone. Add a headline to that template in the graphics editor to burn a title.'
const NO_SECONDARY = 'The saved TikTok watermark template has no line under its headline, so only the burned title is drawn.'
const WRITE_NOTE = 'Write title asks Astra for three options from the short\'s brief and beats; pick one, then edit it. Typing a title costs nothing.'

export function GoalFinishTitle({ headline, secondary, slots, estimate, options, issue, disabled, onHeadline, onSecondary, onWrite }: GoalFinishTitleProps) {
  const blocked = !slots.headline
  return <fieldset className="goal-finish-title" disabled={disabled || blocked}>
    {blocked && <p role="note" className="goal-panel-muted">{NO_HEADLINE}</p>}
    <label><span>Burned title</span><textarea aria-label="Burned title" value={headline} maxLength={SHORT_FINISH_TITLE_LIMITS.headline.characters} rows={2} onChange={event => onHeadline(event.target.value)} /></label>
    <label><span>English line</span><textarea aria-label="English line" value={secondary} maxLength={SHORT_FINISH_TITLE_LIMITS.secondary.characters} rows={2} disabled={!slots.secondary} onChange={event => onSecondary(event.target.value)} /></label>
    {slots.headline && !slots.secondary && <p role="note" className="goal-panel-muted">{NO_SECONDARY}</p>}
    {issue && <p role="alert" className="goal-panel-warning">{issue}</p>}
    <button type="button" className="goal-panel-button" onClick={onWrite}>Write title · {shortEstimateText(estimate)}</button>
    {options.length > 0 && <ul className="goal-title-options" aria-label="Title options">{options.map(option => {
      const picked = option.headline === headline.trim() && (!slots.secondary || option.secondary === secondary.trim())
      return <li key={`${option.headline}\n${option.secondary}`}>
        <button type="button" className="goal-title-option" aria-pressed={picked} onClick={() => { onHeadline(option.headline); onSecondary(slots.secondary ? option.secondary : '') }}>
          <strong>{option.headline}</strong>{option.secondary && <span>{option.secondary}</span>}
        </button>
      </li>
    })}</ul>}
    {!blocked && <p className="goal-panel-muted">{WRITE_NOTE}</p>}
  </fieldset>
}

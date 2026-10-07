import { GOAL_PROMPT_BUDGET, goalPromptWords } from '../../../server/src/goal-prompt-budget'

export function GoalPromptInput({ label, name = label, value, budget, maxLength = 6000, disabled, placeholder, onChange }: {
  label: string
  name?: string
  value: string
  budget: keyof typeof GOAL_PROMPT_BUDGET
  maxLength?: number
  disabled: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  const words = goalPromptWords(value)
  const limit = GOAL_PROMPT_BUDGET[budget]
  return <label className="goal-prompt-input">
    <span>{label}</span>
    <textarea aria-label={name} value={value} maxLength={maxLength} rows={Math.max(2, value.split('\n').length)} disabled={disabled} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    <small className="goal-panel-muted">{words} / {limit} words{words > limit ? ' · Shorter prompts are easier to review' : ''}</small>
  </label>
}

export function GoalPromptInput({ label, name = label, value, wordLimit, maxLength = 6000, disabled, placeholder, onChange }: {
  label: string
  name?: string
  value: string
  wordLimit: number
  maxLength?: number
  disabled: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  const words = value.trim().split(/\s+/u).filter(Boolean).length
  return <label className="goal-prompt-input">
    <span>{label}</span>
    <textarea aria-label={name} value={value} maxLength={maxLength} rows={Math.max(2, value.split('\n').length)} disabled={disabled} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    <small className="goal-panel-muted">{words} / {wordLimit} words{words > wordLimit ? ' · Shorter prompts are easier to review' : ''}</small>
  </label>
}

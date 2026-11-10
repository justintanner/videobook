import { useState, type ReactNode } from 'react'

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="graphics-section" aria-label={title}>
      <span className="graphics-section-label">{title}</span>
      {children}
    </section>
  )
}

export function Choice<T extends string>({ label, value, options, labels, disabled, onChange }: {
  label: string
  value: T
  options: readonly T[]
  labels: Record<T, string>
  disabled: boolean
  onChange: (value: T) => void
}) {
  return (
    <div className="graphics-choice" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" aria-pressed={option === value} disabled={disabled} onClick={() => onChange(option)}>
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

export function Range({ label, value, min, max, step, disabled, format, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  format: (value: number) => string
  onChange: (value: number) => void
}) {
  return (
    <label className="graphics-range">
      <span>{label}<output>{format(value)}</output></span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

export function Color({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <label className="graphics-color">
      <span>{label}</span>
      <input type="color" aria-label={label} value={value.toLowerCase()} disabled={disabled} onChange={(event) => onChange(event.target.value.toUpperCase())} />
    </label>
  )
}

export function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="graphics-switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Select<T extends string>({ label, value, options, disabled, onChange }: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled: boolean
  onChange: (value: T) => void
}) {
  return (
    <label className="graphics-select">
      <span>{label}</span>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

export function CheckedText({ label, value, placeholder, disabled, hint, accepts, onChange }: {
  label: string
  value: string
  placeholder: string
  disabled: boolean
  hint: string
  accepts: (value: string) => boolean
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const change = (next: string) => {
    if (!accepts(next)) {
      setDraft(next)
      return
    }
    setDraft(null)
    onChange(next)
  }
  return (
    <label className="graphics-field">
      <span>{label}</span>
      <input
        type="text"
        aria-label={label}
        aria-invalid={draft !== null}
        value={draft ?? value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => change(event.target.value)}
        onBlur={() => setDraft(null)}
      />
      {draft !== null && <span className="graphics-field-hint">{hint}</span>}
    </label>
  )
}

import type {
  GenerationControl,
  GenerationControlValue,
} from '@/videobook/notebook-generation-actions'
import { effectiveGenerationControlValue } from '@/videobook/notebook-generation-actions'

function generationControlOptionValue(value: GenerationControlValue): string {
  return `${typeof value}:${String(value)}`
}

export type GenerationControlFieldProps = {
  control: GenerationControl
  settings: Record<string, GenerationControlValue>
  busy: boolean
  onFocus?: () => void
  onChange: (value: GenerationControlValue | undefined) => void
  toggleClassName?: string
  booleanLabelFirst?: boolean
  labelAsSpan?: boolean
}

export function GenerationControlField({
  control,
  settings,
  busy,
  onFocus,
  onChange,
  toggleClassName,
  booleanLabelFirst = true,
  labelAsSpan = true,
}: GenerationControlFieldProps) {
  const rawValue = settings[control.name]
  const value = effectiveGenerationControlValue(control, settings)
  if (control.kind === 'boolean') {
    const label = <span>{control.label}</span>
    return (
      <label className={toggleClassName} title={control.description}>
        {booleanLabelFirst && label}
        <input
          type="checkbox"
          role="switch"
          checked={value === true}
          disabled={busy}
          onFocus={onFocus}
          onChange={(event) => onChange(event.target.checked)}
        />
        {!booleanLabelFirst && label}
      </label>
    )
  }
  const label = labelAsSpan ? <span>{control.label}</span> : control.label
  if (control.kind === 'select') {
    const encodedValue = rawValue === undefined
      ? ''
      : generationControlOptionValue(rawValue)
    const savedOption = rawValue !== undefined
      && !control.options.some((option) => option === rawValue)
    return (
      <label title={control.description}>
        {label}
        <select
          aria-label={control.label}
          value={encodedValue}
          disabled={busy}
          onFocus={onFocus}
          onChange={(event) => {
            const selected = control.options.find((option) =>
              generationControlOptionValue(option) === event.target.value)
            onChange(selected)
          }}
        >
          <option value="">
            {control.defaultValue === undefined
              ? control.required ? 'Select…' : 'Auto'
              : `Default · ${String(control.defaultValue)}`}
          </option>
          {savedOption && (
            <option value={encodedValue}>{String(rawValue)} · incompatible</option>
          )}
          {control.options.map((option) => (
            <option
              key={generationControlOptionValue(option)}
              value={generationControlOptionValue(option)}
            >
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <label title={control.description}>
      {label}
      <input
        type={control.kind === 'number' ? 'number' : 'text'}
        aria-label={control.label}
        min={control.minimum}
        max={control.maximum}
        step={control.kind === 'number' ? 'any' : undefined}
        value={value === undefined ? '' : String(value)}
        disabled={busy}
        onFocus={onFocus}
        onChange={(event) => {
          const next = event.target.value
          if (!next) {
            onChange(undefined)
            return
          }
          const numeric = Number(next)
          onChange(control.kind === 'number'
            ? Number.isFinite(numeric) ? numeric : undefined
            : next)
        }}
      />
    </label>
  )
}

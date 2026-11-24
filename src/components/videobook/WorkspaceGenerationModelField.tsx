import { Fragment } from 'react'
import type { ActionChoice } from '@/videobook/workspace-actions'
import {
  generationModelChoices,
  generationModelIdForChange,
  generationProviderChoices,
} from '@/videobook/generation-frontier'

type WorkspaceGenerationModelFieldProps = {
  media: string
  values: Record<string, unknown>
  value: string
  choices: readonly ActionChoice[]
  providerMemory?: Readonly<Record<string, string>>
  required?: boolean
  disabled?: boolean
  hint?: string
  onChange: (value: string | undefined) => void
  onRememberProvider?: (familyId: string, provider: string) => void
}

function optionGroups(options: readonly ActionChoice[]): string[] {
  return [...new Set(options.map(option => option.group ?? ''))]
}

function ChoiceOptions({ options }: { options: readonly ActionChoice[] }) {
  return optionGroups(options).map(group => {
    const entries = options.filter(option => (option.group ?? '') === group).map(option => (
      <option key={option.value} value={option.value} disabled={option.available === false}>{option.label}</option>
    ))
    return group
      ? <optgroup key={group} label={group}>{entries}</optgroup>
      : <Fragment key="ungrouped">{entries}</Fragment>
  })
}

export function WorkspaceGenerationModelField({
  media,
  values,
  value,
  choices,
  providerMemory,
  required = false,
  disabled = false,
  hint,
  onChange,
  onRememberProvider,
}: WorkspaceGenerationModelFieldProps) {
  const draft = value ? { ...values, model: value } : values
  const models = generationModelChoices(choices, media, draft)
  const familyId = choices.find(choice => choice.value === value)?.family?.id ?? ''
  const providers = familyId ? generationProviderChoices(choices, familyId, media, draft) : []
  const listed = providers.some(option => option.value === value)
  const emptyModel = required ? 'Choose model' : 'Use default'
  const emptyProvider = listed ? '' : familyId || required ? 'Choose provider' : 'Use default'

  return (
    <div className="workspace-action-field workspace-action-wide workspace-generation-models">
      {hint && <p className="workspace-action-hint">{hint}</p>}
      <label>
        <span>Model{required && <span aria-hidden="true"> *</span>}</span>
        <select
          aria-label="Generation model"
          required={required}
          disabled={disabled || models.length === 0}
          value={familyId}
          onChange={(event) => onChange(generationModelIdForChange(choices, media, draft, { familyId: event.target.value }, providerMemory))}
        >
          <option value="">{models.length ? emptyModel : 'No model available'}</option>
          <ChoiceOptions options={models} />
        </select>
      </label>
      <label>
        <span>Provider</span>
        <select
          aria-label="Generation provider"
          disabled={disabled || !familyId || (listed && providers.length < 2)}
          value={listed ? value : ''}
          onChange={(event) => {
            const provider = providers.find(option => option.value === event.target.value)?.provider
            if (familyId && provider) onRememberProvider?.(familyId, provider)
            onChange(generationModelIdForChange(choices, media, draft, { modelId: event.target.value }))
          }}
        >
          {emptyProvider && <option value="">{emptyProvider}</option>}
          {providers.map(option => (
            <option key={`${option.provider ?? ''}:${option.value}`} value={option.value} disabled={option.available === false}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

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
  required?: boolean
  disabled?: boolean
  hint?: string
  onChange: (value: string | undefined) => void
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
  required = false,
  disabled = false,
  hint,
  onChange,
}: WorkspaceGenerationModelFieldProps) {
  const draft = value ? { ...values, model: value } : values
  const models = generationModelChoices(choices, media, draft)
  const familyId = choices.find(choice => choice.value === value)?.family?.id ?? ''
  const providers = familyId ? generationProviderChoices(choices, familyId, media, draft) : []
  const resolved = familyId ? generationModelIdForChange(choices, media, draft, { familyId }) ?? '' : ''
  const providerValue = providers.some(option => option.value === value) ? value : resolved
  const shownProvider = providers.some(option => option.value === providerValue) ? providerValue : ''
  const emptyModel = required ? 'Choose model' : 'Use default'
  const emptyProvider = shownProvider === '' ? (required ? 'Choose provider' : 'Use default') : ''

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
          onChange={(event) => onChange(generationModelIdForChange(choices, media, draft, { familyId: event.target.value }))}
        >
          <option value="">{models.length ? emptyModel : 'No model available'}</option>
          <ChoiceOptions options={models} />
        </select>
      </label>
      <label>
        <span>Provider</span>
        <select
          aria-label="Generation provider"
          disabled={disabled || !familyId || providers.length < 2}
          value={shownProvider}
          onChange={(event) => onChange(generationModelIdForChange(choices, media, draft, { modelId: event.target.value }))}
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

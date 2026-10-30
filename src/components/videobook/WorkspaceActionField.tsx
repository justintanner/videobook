import { useId, useState } from 'react'
import type { ActionInputSchema } from '../../../server/src/workspace-action-contract'
import {
  actionFieldLabel,
  actionInputVariants,
  initialActionInput,
  resolvedActionInputSchema,
} from '@/videobook/workspace-actions'
import type { ActionChoice } from '@/videobook/workspace-actions'

type ActionFieldProps = {
  name: string
  schema: ActionInputSchema
  value: unknown
  required?: boolean
  disabled?: boolean
  choices: Record<string, readonly ActionChoice[]>
  choiceName?: string
  onChange: (value: unknown) => void
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function variantLabel(schema: ActionInputSchema): string {
  const discriminant = Object.values(schema.properties ?? {}).find((field) => 'const' in field)
  return schema.title ?? (discriminant ? actionFieldLabel(String(discriminant.const)) : actionFieldLabel(String(schema.type ?? 'value')))
}

type FieldLayout = 'wide' | 'compact' | 'compact-short'

function fieldLayout(name: string, schema: ActionInputSchema, variantCount: number): FieldLayout {
  if (variantCount > 1 || !schema.type || schema.type === 'object' || schema.type === 'array') return 'wide'
  const number = schema.type === 'number' || schema.type === 'integer'
  if (number) return 'compact-short'
  if (/prompt|text|description|markdown|content|script/u.test(name)) return 'wide'
  return 'compact'
}

const FIELD_LAYOUT_CLASS: Record<FieldLayout, string> = {
  wide: 'workspace-action-field workspace-action-wide',
  compact: 'workspace-action-field workspace-action-compact',
  'compact-short': 'workspace-action-field workspace-action-compact workspace-action-short',
}

function JsonActionInput({ id, value, disabled, onChange }: {
  id: string
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  return (
    <textarea
      id={id}
      value={text}
      disabled={disabled}
      rows={5}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value
        setText(next)
        try {
          onChange(next.trim() ? JSON.parse(next) as unknown : undefined)
          event.target.setCustomValidity('')
        } catch {
          event.target.setCustomValidity('Enter valid JSON for these additional options.')
        }
      }}
    />
  )
}

export function WorkspaceActionField({
  name,
  schema,
  value,
  required = false,
  disabled = false,
  choices,
  choiceName,
  onChange,
}: ActionFieldProps) {
  const id = useId()
  const variants = actionInputVariants(schema)
  const [inputFormat, setInputFormat] = useState<number | null>(null)
  const resolved = inputFormat === null
    ? resolvedActionInputSchema(schema, value)
    : { ...schema, ...variants[inputFormat] }
  const label = schema.title ?? actionFieldLabel(name)
  const options = choices[choiceName ?? name]
  const optionGroups = options ? [...new Set(options.map(option => option.group ?? ''))] : []
  const structured = resolved.type === 'object' || resolved.type === 'array'
  const selectedVariant = variants.findIndex((variant) => variantLabel(variant) === variantLabel(resolved))
  const enumValues = resolved.enum ?? (resolved.type === 'boolean' ? [true, false] : undefined)
  const collapsed = structured && !required && value === undefined
  const layout = (collapsed || (!structured && (enumValues || options))) && variants.length <= 1 ? 'compact' : fieldLayout(name, resolved, variants.length)
  const object = objectValue(value)
  const values = Array.isArray(value) ? value : []

  if ('const' in resolved) {
    return <div className="workspace-action-fixed"><span>{label}</span><strong>{String(resolved.const)}</strong></div>
  }

  const scalar = () => {
    if (enumValues) {
      return (
        <select id={id} required={required} disabled={disabled}
          value={value === undefined ? '' : String(enumValues.indexOf(value))}
          onChange={(event) => onChange(event.target.value === '' ? undefined : enumValues[Number(event.target.value)])}>
          <option value="">{required ? `Choose ${label.toLowerCase()}` : 'Use default'}</option>
          {enumValues.map((option, index) => <option key={index} value={index}>{typeof option === 'boolean' ? option ? 'Yes' : 'No' : String(option)}</option>)}
        </select>
      )
    }
    if (options) {
      return (
        <select id={id} required={required} disabled={disabled} value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">{options.length ? `Choose ${label.toLowerCase()}` : `No ${label.toLowerCase()} available`}</option>
          {optionGroups.map(group => {
            const entries = options.filter(option => (option.group ?? '') === group).map(option => (
              <option key={option.value} value={option.value} disabled={option.available === false}>{option.label}{option.detail ? ` · ${option.detail}` : ''}</option>
            ))
            return group ? <optgroup key={group} label={group}>{entries}</optgroup> : entries
          })}
        </select>
      )
    }
    if (!resolved.type) return <JsonActionInput id={id} value={value} disabled={disabled} onChange={onChange} />
    if (resolved.type === 'null') return <output id={id}>No value</output>
    const number = resolved.type === 'number' || resolved.type === 'integer'
    const secret = resolved.format === 'password' || /secret|password|api_key|access_token/u.test(name)
    const multiline = !number && /prompt|text|description|markdown|content|script/u.test(name)
    if (multiline) {
      return <textarea id={id} value={typeof value === 'string' ? value : ''} disabled={disabled} required={required}
        minLength={resolved.minLength} maxLength={resolved.maxLength} rows={4} onChange={(event) => onChange(event.target.value)} />
    }
    return (
      <input id={id} type={number ? 'number' : secret ? 'password' : 'text'}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        required={required} disabled={disabled} autoComplete="off"
        step={resolved.type === 'integer' ? 1 : 'any'}
        min={resolved.minimum ?? (resolved.type === 'integer' && resolved.exclusiveMinimum !== undefined ? resolved.exclusiveMinimum + 1 : undefined)}
        max={resolved.maximum ?? (resolved.type === 'integer' && resolved.exclusiveMaximum !== undefined ? resolved.exclusiveMaximum - 1 : undefined)}
        minLength={resolved.minLength} maxLength={resolved.maxLength}
        onChange={(event) => onChange(number ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value)}
      />
    )
  }

  return (
    <div className={`${FIELD_LAYOUT_CLASS[layout]}${structured ? ' workspace-action-structure' : ''}`}>
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      {schema.description && <p className="workspace-action-hint">{schema.description}</p>}
      {variants.length > 1 && (
        <select aria-label={`${label} format`} disabled={disabled} value={Math.max(0, selectedVariant)}
          onChange={(event) => {
            const index = Number(event.target.value)
            setInputFormat(index)
            onChange(initialActionInput(variants[index]!, true))
          }}>
          {variants.map((variant, index) => <option key={index} value={index}>{variantLabel(variant)}</option>)}
        </select>
      )}
      {collapsed
        ? <button type="button" disabled={disabled} onClick={() => onChange(initialActionInput(resolved, true))}>Add {label.toLowerCase()}</button>
        : resolved.type === 'object'
          ? Object.keys(resolved.properties ?? {}).length
            ? <fieldset id={id} disabled={disabled} aria-label={label}>
                {Object.entries(resolved.properties ?? {}).map(([key, field]) => (
                  <WorkspaceActionField key={key} name={key} schema={field} value={object[key]} choices={choices}
                    required={resolved.required?.includes(key)} disabled={disabled}
                    onChange={(next) => onChange({ ...object, [key]: next })} />
                ))}
              </fieldset>
            : <JsonActionInput id={id} value={value} disabled={disabled} onChange={onChange} />
          : resolved.type === 'array'
            ? <fieldset id={id} disabled={disabled} aria-label={label}>
                {values.map((item, index) => (
                  <div className="workspace-action-array-row" key={index}>
                    <WorkspaceActionField name={`${name} ${index + 1}`} schema={resolved.items ?? {}} value={item}
                      required choices={choices} choiceName={choiceName ?? name} disabled={disabled}
                      onChange={(next) => onChange(values.map((entry, position) => position === index ? next : entry))} />
                    <button type="button" disabled={disabled || values.length <= (resolved.minItems ?? 0)}
                      aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(values.filter((_, position) => position !== index))}>Remove</button>
                  </div>
                ))}
                <button type="button" disabled={disabled || (resolved.maxItems !== undefined && values.length >= resolved.maxItems)}
                  onClick={() => onChange([...values, initialActionInput(resolved.items ?? {}, true)])}>Add item</button>
              </fieldset>
            : scalar()}
      {structured && !required && value !== undefined && (
        <button type="button" disabled={disabled} onClick={() => onChange(undefined)}>Use default {label.toLowerCase()}</button>
      )}
    </div>
  )
}

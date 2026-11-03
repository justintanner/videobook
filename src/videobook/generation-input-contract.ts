import { REF_ROLES, type InputLimit, type InputLimitBound, type ItemParamSpec, type RefRole } from '../../server/src/media/types'
import type {
  NotebookGenerationInputField,
  NotebookGenerationInputSpec,
} from '../../server/src/notebook-generation-contract'
import { nonBlankStringValue, recordValue } from './value-decoders'

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null
  return finite(value) ?? undefined
}

function mediaKind(value: unknown): NotebookGenerationInputSpec['kind'] | null {
  return value === 'image' || value === 'video' || value === 'audio' ? value : null
}

function refRole(value: unknown): RefRole | null {
  return REF_ROLES.find((role) => role === value) ?? null
}

function itemParamSpec(value: unknown): ItemParamSpec | null {
  const spec = recordValue(value)
  const name = nonBlankStringValue(spec?.name)
  const label = nonBlankStringValue(spec?.label)
  const valueType = spec?.valueType
  if (!spec || !name || !label || (valueType !== 'number' && valueType !== 'integer')) return null
  const minimum = finite(spec.minimum)
  const maximum = finite(spec.maximum)
  const defaultValue = finite(spec.defaultValue)
  const unit = nonBlankStringValue(spec.unit)
  const legacyOptions = Array.isArray(spec.legacyOptions)
    ? spec.legacyOptions.map((option) => typeof option === 'string' ? option : '')
    : []
  return {
    name,
    label,
    valueType,
    ...(minimum === null ? {} : { minimum }),
    ...(maximum === null ? {} : { maximum }),
    ...(spec.exclusiveMinimum === true ? { exclusiveMinimum: true } : {}),
    ...(unit ? { unit } : {}),
    ...(defaultValue === null ? {} : { defaultValue }),
    ...(spec.computedDefault === 'even_seconds' ? { computedDefault: 'even_seconds' as const } : {}),
    ...(legacyOptions.length > 0 ? { legacyOptions } : {}),
  }
}

function inputField(value: unknown): NotebookGenerationInputField | null {
  const field = recordValue(value)
  const path = nonBlankStringValue(field?.path)
  const label = nonBlankStringValue(field?.label)
  const max = nullableFinite(field?.max)
  return path && label && max !== undefined ? { path, label, max } : null
}

function inputSpec(value: unknown): NotebookGenerationInputSpec | null {
  const spec = recordValue(value)
  const target = nonBlankStringValue(spec?.target)
  const kind = mediaKind(spec?.kind)
  const label = nonBlankStringValue(spec?.label)
  const min = finite(spec?.min)
  const max = nullableFinite(spec?.max)
  if (!spec || !target || !kind || !label || min === null || max === undefined) return null
  return {
    target,
    kind,
    label,
    fields: Array.isArray(spec.fields) ? spec.fields.flatMap((field) => inputField(field) ?? []) : [],
    min,
    max,
    token: nonBlankStringValue(spec.token),
    itemParams: Array.isArray(spec.itemParams) ? spec.itemParams.flatMap((param) => itemParamSpec(param) ?? []) : [],
    sent: spec.sent !== false,
  }
}

function limitBound(value: unknown): InputLimitBound | null {
  const number = finite(value)
  if (number !== null) return number
  const bound = recordValue(value)
  const option = nonBlankStringValue(bound?.option)
  const offset = finite(bound?.offset)
  const cap = finite(bound?.cap)
  return option && offset !== null && cap !== null ? { option, offset, cap } : null
}

function limitRoles(value: unknown): Array<{ role: RefRole; weight?: number }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const record = recordValue(entry)
    const role = refRole(record?.role)
    const weight = finite(record?.weight)
    return role ? [{ role, ...(weight === null ? {} : { weight }) }] : []
  })
}

function limitWhen(value: unknown): { option: string; equals: string | number | boolean } | null {
  const when = recordValue(value)
  const option = nonBlankStringValue(when?.option)
  const equals = when?.equals
  return option && (typeof equals === 'string' || typeof equals === 'number' || typeof equals === 'boolean')
    ? { option, equals }
    : null
}

function inputLimit(value: unknown): InputLimit | null {
  const limit = recordValue(value)
  const message = nonBlankStringValue(limit?.message)
  if (!limit || !message) return null
  if (limit.kind === 'requires') {
    const role = refRole(limit.role)
    const requires = refRole(limit.requires)
    return role && requires ? { kind: 'requires', role, requires, message } : null
  }
  const roles = limitRoles(limit.roles)
  const max = limitBound(limit.max)
  const when = limitWhen(limit.when)
  if (limit.kind !== 'max' || roles.length === 0 || max === null) return null
  return { kind: 'max', roles, max, ...(when ? { when } : {}), message }
}

export function generationInputSpecs(value: unknown): NotebookGenerationInputSpec[] | null {
  return Array.isArray(value) ? value.flatMap((spec) => inputSpec(spec) ?? []) : null
}

export function generationInputLimits(value: unknown): InputLimit[] | null {
  return Array.isArray(value) ? value.flatMap((limit) => inputLimit(limit) ?? []) : null
}

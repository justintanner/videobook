import { describe, it, expect } from 'vitest'
import { coerceArgsToSchema, coerceValueToSchemaType } from './fieldHelpers'
import type { JSONSchemaProperty } from '../types'

describe('coerceValueToSchemaType', () => {
  it('coerces numeric strings to integers', () => {
    const prop: JSONSchemaProperty = { type: 'integer', minimum: 6, maximum: 30 }
    expect(coerceValueToSchemaType('6', prop)).toBe(6)
    expect(coerceValueToSchemaType('12', prop)).toBe(12)
  })

  it('coerces numeric strings to numbers', () => {
    const prop: JSONSchemaProperty = { type: 'number' }
    expect(coerceValueToSchemaType('1.5', prop)).toBe(1.5)
  })

  it('leaves already-numeric values alone', () => {
    const prop: JSONSchemaProperty = { type: 'integer' }
    expect(coerceValueToSchemaType(8, prop)).toBe(8)
  })

  it('coerces numbers to strings for string fields', () => {
    const prop: JSONSchemaProperty = { type: 'string', enum: ['4', '6', '8'] }
    expect(coerceValueToSchemaType(6, prop)).toBe('6')
  })

  it('coerces boolean strings', () => {
    const prop: JSONSchemaProperty = { type: 'boolean' }
    expect(coerceValueToSchemaType('true', prop)).toBe(true)
    expect(coerceValueToSchemaType('false', prop)).toBe(false)
  })
})

describe('coerceArgsToSchema', () => {
  it('coerces duration string for grok-style integer schema', () => {
    const properties: Record<string, JSONSchemaProperty> = {
      duration: { type: 'integer', minimum: 6, maximum: 30 },
      mode: { type: 'string', enum: ['fun', 'normal'] },
      nsfw_checker: { type: 'boolean' },
    }
    const out = coerceArgsToSchema(
      { duration: '6', mode: 'fun', nsfw_checker: 'No', prompt: 'hi' },
      properties,
    )
    expect(out.duration).toBe(6)
    expect(out.mode).toBe('fun')
    expect(out.nsfw_checker).toBe(false)
    expect(out.prompt).toBe('hi')
  })
})

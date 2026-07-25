import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gateForRequirement } from './mvp-gates'

describe('MVP gate traceability', () => {
  it('maps every P0 PRD requirement to one delivery gate', () => {
    const prd = readFileSync(new URL('../../docs/mvp-prd.md', import.meta.url), 'utf8')
    const requirements = [...prd.matchAll(
      /^\|\s*(VB-[A-Z]+-\d+)\s*\|\s*P0\s*\|/gm,
    )].map((match) => match[1]!)
    expect(requirements.length).toBeGreaterThan(50)
    expect(requirements.map((requirement) => (
      [requirement, gateForRequirement(requirement)]
    ))).toHaveLength(requirements.length)
  })

  it('matches the PRD delivery-gate ownership', () => {
    expect(gateForRequirement('VB-ING-001')).toBe('G1')
    expect(gateForRequirement('VB-SRC-001')).toBe('G1')
    expect(gateForRequirement('VB-NBK-001')).toBe('G2')
    expect(gateForRequirement('VB-CMD-001')).toBe('G3')
    expect(gateForRequirement('VB-EDT-001')).toBe('G4')
    expect(gateForRequirement('VB-AI-001')).toBe('G4')
    expect(gateForRequirement('VB-EXP-001')).toBe('G4')
    expect(gateForRequirement('VB-NFR-001')).toBe('G5')
  })
})

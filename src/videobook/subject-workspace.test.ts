import { describe, expect, it } from 'vitest'
import {
  subjectWorkspaceExpanded,
  type SubjectWorkspaceState,
} from './subject-workspace'

function state(patch: Partial<SubjectWorkspaceState> = {}): SubjectWorkspaceState {
  return {
    docked: true,
    requested: null,
    working: false,
    hasContent: false,
    ...patch,
  }
}

describe('subject workspace expansion', () => {
  it('rests as a header row while docked with nothing to show', () => {
    expect(subjectWorkspaceExpanded(state())).toBe(false)
  })

  it('stays open in its own column, where height costs the picture nothing', () => {
    expect(subjectWorkspaceExpanded(state({ docked: false }))).toBe(true)
    expect(subjectWorkspaceExpanded(state({ docked: false, requested: false })))
      .toBe(true)
  })

  it('opens itself while analysis runs so its progress is visible', () => {
    expect(subjectWorkspaceExpanded(state({ working: true }))).toBe(true)
  })

  it('opens itself once there are subjects, regions or errors to act on', () => {
    expect(subjectWorkspaceExpanded(state({ hasContent: true }))).toBe(true)
  })

  it('lets the viewer collapse it back over work it opened for', () => {
    const busy = state({ working: true, hasContent: true, requested: false })
    expect(subjectWorkspaceExpanded(busy)).toBe(false)
  })

  it('lets the viewer open it with nothing to show yet', () => {
    expect(subjectWorkspaceExpanded(state({ requested: true }))).toBe(true)
  })
})

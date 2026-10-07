import { describe, expect, it } from 'vitest'
import { goalPlansEqual } from '../../src/videobook/goals'
import type { GoalPlan } from '../../server/src/goal-plan'

describe('goal review persistence', () => {
  it('keeps a saved plan clean when storage reorders fields, but detects changed shots', () => {
    const draft: GoalPlan = {
      title: 'Skateboard dog', continuity: 'Terrier in a red helmet', aspectRatio: '16:9',
      shots: [{ title: 'Opening', prompt: 'The dog rides a skateboard.', durationSeconds: 10 }],
    }
    const stored: GoalPlan = {
      aspectRatio: '16:9', shots: [{ durationSeconds: 10, prompt: 'The dog rides a skateboard.', title: 'Opening' }],
      continuity: 'Terrier in a red helmet', title: 'Skateboard dog',
    }
    expect(goalPlansEqual(draft, stored)).toBe(true)
    expect(goalPlansEqual(draft, { ...stored, shots: [{ ...stored.shots[0]!, durationSeconds: 12 }] })).toBe(false)
    expect(goalPlansEqual(draft, { ...stored, shots: [...stored.shots, stored.shots[0]!] })).toBe(false)
  })
})

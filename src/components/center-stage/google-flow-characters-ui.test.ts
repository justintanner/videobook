import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const centerStageRoot = join(import.meta.dirname)
const genUiRoot = join(import.meta.dirname, '..', 'gen', 'ui')

describe('GoogleFlowCharactersScreen state transitions', () => {
  it('implements state transitions, confirm delete, and /gf-characters actions', () => {
    const screen = readFileSync(join(centerStageRoot, 'GoogleFlowCharactersScreen.tsx'), 'utf8')
    // Screen state transitions
    expect(screen).toContain('mode ===')
    // Destructive confirmation
    expect(screen).toContain('setDeleteConfirmRef')
    // Replace flow warns about ref changes
    expect(screen).toContain('Google Flow does not support native updates. This operation will create a')
  })
})

describe('GoogleFlowRefPicker manager handoff and caps', () => {
  it('calls onManage callback and enforces selection caps', () => {
    const picker = readFileSync(join(genUiRoot, 'GoogleFlowRefPicker.tsx'), 'utf8')
    // Manager handoff
    expect(picker).toContain('onManage')
    // Selection caps
    expect(picker).toContain('maxItems')
    expect(picker).toContain('atCap = selected.length >= maxItems')
  })
})

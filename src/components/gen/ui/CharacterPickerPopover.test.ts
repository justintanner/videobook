import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname)

describe('CharacterPickerPopover layout', () => {
  it('renders a true inline layout for variant="inline"', () => {
    const popover = readFileSync(join(root, 'CharacterPickerPopover.tsx'), 'utf8')
    
    // It should check the variant prop to conditionally render the popup wrapper
    expect(popover).toContain("variant === 'inline'")
    
    // Inline variant gets normal flow classes
    expect(popover).toContain("'mt-2 w-full rounded border overflow-hidden'")
    
    // Default variant keeps absolute floating overlay
    expect(popover).toContain("'absolute top-full left-0 mt-1 w-72 max-h-80 rounded border z-50 overflow-hidden'")
  })
})

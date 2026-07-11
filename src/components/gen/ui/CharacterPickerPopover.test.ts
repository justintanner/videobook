import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname)

describe('CharacterPickerPopover inline manager', () => {
  const picker = readFileSync(join(root, 'CharacterPickerPopover.tsx'), 'utf8')

  it('renders always-inline with no popover or create-form mode', () => {
    // Drop zone + chips live in normal flow; no floating overlay classes remain
    expect(picker).not.toContain('absolute top-full')
    expect(picker).not.toContain('createMode')
    expect(picker).not.toContain('CreateCharacterForm')
    expect(picker).toContain('DROP IMAGES TO CREATE')
  })

  it('drag-to-create names the character from the dropped asset', () => {
    expect(picker).toContain('nameFromAsset')
    expect(picker).toContain('create_google_flow_character')
    expect(picker).toContain('.slice(0, 2)')
  })

  it('rename surfaces tool errors and swaps the recreated ref into the selection', () => {
    expect(picker).toContain('rename_google_flow_character')
    // MCP tools report failures as isError content, not thrown errors
    expect(picker).toMatch(/rename_google_flow_character[\s\S]*?if \(result\.isError\)/)
    // Rename recreates server-side, so the old ref must be swapped for the new one
    expect(picker).toMatch(/selectedRefs\.map\(\(r\) => \(r === ref \? parsed\.character_ref! : r\)\)/)
    // In-flight state is tracked per chip
    expect(picker).toContain('renamingRef')
  })
})

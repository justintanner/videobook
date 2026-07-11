import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sharedFiniteBounds } from './clip-window'

const root = join(import.meta.dirname)

describe('notebook characters compact trigger wiring', () => {
  it('sidebar uses CharacterPickerPopover inline variant with step domain', () => {
    const sidebar = readFileSync(join(root, 'NotebookSidebar.tsx'), 'utf8')
    expect(sidebar).toContain('variant="inline"')
    expect(sidebar).toContain('domain="notebook"')
    expect(sidebar).toContain('character_refs')
    // Characters only when schema + mode support character_refs
    expect(sidebar).toMatch(/modeVisible\.has\('character_refs'\)/)
  })

  it('CharacterPickerPopover exposes inline variant without changing default gen-panel path', () => {
    const picker = readFileSync(
      join(root, '../../gen/ui/CharacterPickerPopover.tsx'),
      'utf8',
    )
    expect(picker).toContain("variant?: 'default' | 'inline'")
    expect(picker).toContain("variant = 'default'")
    expect(picker).toContain('vc-notebook-characters-inline')
    expect(picker).toContain('Characters')
  })
})

describe('notebook clip composite field exclusion wiring', () => {
  it('excludes video_clip_* from DynamicField list when composite applies', () => {
    const sidebar = readFileSync(join(root, 'NotebookSidebar.tsx'), 'utf8')
    expect(sidebar).toContain('showClipComposite')
    expect(sidebar).toContain("name === 'video_clip_start' || name === 'video_clip_ends'")
    expect(sidebar).toContain('ClipWindowControl')
    expect(sidebar).toContain('Clip window')
  })

  it('sharedFiniteBounds drives dual-range vs paired numeric fallback', () => {
    expect(sharedFiniteBounds({ minimum: 0, maximum: 10 }, { minimum: 0, maximum: 10 })).not.toBeNull()
    expect(sharedFiniteBounds({ minimum: 0 }, { minimum: 0, maximum: 10 })).toBeNull()
  })
})

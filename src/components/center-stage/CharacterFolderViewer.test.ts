import { describe, it, expect } from 'vitest'
import { categorizeManifestFiles } from './character-folder-utils'
import type { ManifestFile } from './viewer-types'

function file(name: string, size_bytes = 100): ManifestFile {
  const ext = name.includes('.') ? name.split('.').pop() ?? null : null
  return { name, size_bytes, extension: ext }
}

describe('categorizeManifestFiles', () => {
  it('buckets by filename using API shape (name / size_bytes)', () => {
    const files = [
      file('original.png', 466566),
      file('landscape.jpg', 301384),
      file('voice.mp3', 12000),
      file('.character.json', 1196),
      file('notes.txt', 40),
    ]
    const { images, audio, others } = categorizeManifestFiles(files)
    expect(images.map((f) => f.name)).toEqual(['original.png', 'landscape.jpg'])
    expect(audio.map((f) => f.name)).toEqual(['voice.mp3'])
    // Dotfiles (e.g. .character.json) are hidden from "Other Files".
    expect(others.map((f) => f.name)).toEqual(['notes.txt'])
  })

  it('does not throw on real /api/manifest field names (regression for path/size crash)', () => {
    // Previously used f.path.match() which threw TypeError when API returned {name, size_bytes}.
    const apiFiles: ManifestFile[] = [
      { name: 'original.png', size_bytes: 466566, extension: 'png' },
      { name: '.created_at', size_bytes: 10, extension: null },
      { name: 'notes.txt', size_bytes: 40, extension: 'txt' },
    ]
    expect(() => categorizeManifestFiles(apiFiles)).not.toThrow()
    const { images, others } = categorizeManifestFiles(apiFiles)
    expect(images).toHaveLength(1)
    // Dotfiles skipped; only non-media non-dot files appear in others.
    expect(others).toHaveLength(1)
    expect(others[0].name).toBe('notes.txt')
    expect(others[0].size_bytes).toBe(40)
  })
})

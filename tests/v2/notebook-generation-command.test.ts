import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import { chatDef } from '../../server/src/tools/chat.js'
import { parseNotebookGenerationCellCommand } from '../../src/videobook/notebook-generation-command'

describe('notebook generation cell commands', () => {
  it('parses explicit configured-cell execution requests', () => {
    expect(parseNotebookGenerationCellCommand(
      'generate cell @a1',
    )).toBe('a1')
    expect(parseNotebookGenerationCellCommand(
      'run @018F7CF5-0D31-7D96-8C0F-800000000001',
    )).toBe('018f7cf5-0d31-7d96-8c0f-800000000001')
    expect(parseNotebookGenerationCellCommand(
      'Please run the cell B2.',
    )).toBe('b2')
  })

  it('leaves natural generation prompts for free-form routing', () => {
    expect(parseNotebookGenerationCellCommand(
      'generate an image with @a1',
    )).toBeNull()
    expect(parseNotebookGenerationCellCommand(
      'generate an image of a sunset',
    )).toBeNull()
    expect(parseNotebookGenerationCellCommand(
      'run a cinematic transformation with @a1',
    )).toBeNull()
  })

  it('resolves the referenced image before the free-form provider boundary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'videobook-generation-route-'))
    const engine = createEngine({
      rootDir,
      initialBookName: 'generation-route',
    })
    const originalApiKey = process.env.OPENAI_API_KEY
    try {
      const artifact = await engine.artifacts.create('image', 'reference')
      expect(artifact.ok).toBe(true)
      if (!artifact.ok) return
      const written = await engine.files.write(
        artifact.value.artifactId,
        'original.png',
        Buffer.from('reference-image'),
      )
      expect(written.ok).toBe(true)
      delete process.env.OPENAI_API_KEY

      const result = await chatDef(engine).handler({
        book_id: engine.book.get().bookId,
        prompt: `generate an image with @${artifact.value.artifactId}`,
      })

      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('OPENAI_API_KEY')
      expect(result.content[0]?.text).not.toContain('Asset not found')
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
      engine.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

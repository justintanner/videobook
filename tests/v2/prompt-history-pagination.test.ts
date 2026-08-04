import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from 'videobook-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { listPromptHistoryDef } from '../../server/src/tools/prompt-history'

function value(result: Awaited<ReturnType<ReturnType<typeof listPromptHistoryDef>['handler']>>) {
  return JSON.parse(result.content[0]!.text) as {
    entries: Array<{ prompt: string }>
    page: {
      offset: number
      limit: number
      total: number
      has_more: boolean
    }
  }
}

describe('prompt history pagination', () => {
  let root = ''

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('pages from newest to oldest without truncating stored history', async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-prompt-history-'))
    const engine = createEngine({ rootDir: root, initialBookName: 'history' })
    try {
      for (let index = 0; index < 5; index += 1) {
        const recorded = await engine.prompts.record({
          surface: 'chat',
          prompt: `msg-${index}`,
        })
        expect(recorded.ok).toBe(true)
      }
      const tool = listPromptHistoryDef(engine)
      const first = value(await tool.handler({
        book_id: engine.book.get().bookId,
        surface: 'chat',
        limit: 2,
        offset: 0,
      }))
      const second = value(await tool.handler({
        book_id: engine.book.get().bookId,
        surface: 'chat',
        limit: 2,
        offset: 2,
      }))
      const last = value(await tool.handler({
        book_id: engine.book.get().bookId,
        surface: 'chat',
        limit: 2,
        offset: 4,
      }))

      expect(first.entries.map((entry) => entry.prompt)).toEqual(['msg-4', 'msg-3'])
      expect(second.entries.map((entry) => entry.prompt)).toEqual(['msg-2', 'msg-1'])
      expect(last.entries.map((entry) => entry.prompt)).toEqual(['msg-0'])
      expect(first.page).toEqual({ offset: 0, limit: 2, total: 5, has_more: true })
      expect(second.page).toEqual({ offset: 2, limit: 2, total: 5, has_more: true })
      expect(last.page).toEqual({ offset: 4, limit: 2, total: 5, has_more: false })
    } finally {
      engine.close()
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  filterPromptHistory,
  pinnedFirst,
  promptHistoryAge,
  promptHistoryArgs,
  promptHistoryEntries,
  uniquePromptHistory,
  type PromptHistoryEntry,
} from '../../src/videobook/generation-prompt-history'

function toolResult(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function entry(prompt: string, id: string): PromptHistoryEntry {
  return { id, surface: 'video_generate', prompt, book: 'spider-realm', model: 'seedance', createdAt: 0 }
}

describe('generation prompt history', () => {
  it('parses list_prompt_history results and skips blank prompts', () => {
    const entries = promptHistoryEntries(toolResult({
      entries: [
        { id: 'a', surface: 'video_generate', prompt: 'portal reveal', params: { model: 'bytedance/seedance-2-5' }, created_at: 1_700_000_000_000, book: 'spider-realm' },
        { id: 'b', surface: 'video_generate', prompt: '   ', params: {}, created_at: 1 },
        { id: 'c', surface: 'image_generate', prompt: 'storyboard', params: { tool: 'generate_image_x' }, created_at: 2 },
      ],
    }))
    expect(entries).toEqual([
      { id: 'a', surface: 'video_generate', prompt: 'portal reveal', book: 'spider-realm', model: 'bytedance/seedance-2-5', createdAt: 1_700_000_000_000 },
      { id: 'c', surface: 'image_generate', prompt: 'storyboard', book: '', model: 'generate_image_x', createdAt: 2 },
    ])
  })

  it('keeps the newest copy of repeated prompts', () => {
    const unique = uniquePromptHistory([entry('same', '3'), entry('other', '2'), entry('same ', '1')])
    expect(unique.map((item) => item.id)).toEqual(['3', '2'])
  })

  it('filters case-insensitively and floats pinned prompts first', () => {
    const entries = [entry('Spider swing', '1'), entry('gym pose', '2'), entry('spider portal', '3')]
    expect(filterPromptHistory(entries, 'SPIDER').map((item) => item.id)).toEqual(['1', '3'])
    expect(pinnedFirst(entries, new Set(['spider portal'])).map((item) => item.id)).toEqual(['3', '1', '2'])
  })

  it('omits the surface argument when every surface is requested', () => {
    expect(promptHistoryArgs({ bookId: 'b', surface: 'video_generate', scope: 'book', surfaceFilter: 'surface' }))
      .toEqual({ book_id: 'b', scope: 'book', limit: 200, surface: 'video_generate' })
    expect(promptHistoryArgs({ bookId: 'b', surface: 'video_generate', scope: 'library', surfaceFilter: 'all' }))
      .toEqual({ book_id: 'b', scope: 'library', limit: 200 })
  })

  it('formats ages from second or millisecond timestamps', () => {
    const now = Date.UTC(2026, 9, 8, 12)
    expect(promptHistoryAge(now - 4 * 60_000, now)).toBe('4m ago')
    expect(promptHistoryAge((now - 3 * 3_600_000) / 1000, now)).toBe('3h ago')
    expect(promptHistoryAge(now - 26 * 3_600_000, now)).toBe('yesterday')
    expect(promptHistoryAge(0, now)).toBe('')
  })
})

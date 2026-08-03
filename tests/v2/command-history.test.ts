import { describe, expect, it } from 'vitest'
import {
  commandHistoryPage,
  navigateCommandHistory,
} from '../../src/videobook/command-history'

describe('command history', () => {
  it('parses paged prompt history from parsed and MCP results', () => {
    const payload = {
      entries: [{ prompt: 'newest' }, { prompt: 'older' }],
      page: { offset: 2, has_more: true },
    }
    expect(commandHistoryPage(payload)).toEqual({
      values: ['newest', 'older'],
      offset: 2,
      hasMore: true,
    })
    expect(commandHistoryPage({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    })).toEqual({
      values: ['newest', 'older'],
      offset: 2,
      hasMore: true,
    })
  })

  it('recalls the failed command first and walks to the oldest command', () => {
    const values = ['oldest', 'middle', 'failed command']
    const first = navigateCommandHistory({
      values,
      cursor: -1,
      draft: '',
      current: '',
      direction: -1,
    })!
    expect(first.value).toBe('failed command')
    const second = navigateCommandHistory({
      values,
      cursor: first.cursor,
      draft: first.draft,
      current: first.value,
      direction: -1,
    })!
    expect(second.value).toBe('middle')
    const third = navigateCommandHistory({
      values,
      cursor: second.cursor,
      draft: second.draft,
      current: second.value,
      direction: -1,
    })!
    expect(third.value).toBe('oldest')
    expect(navigateCommandHistory({
      values,
      cursor: third.cursor,
      draft: third.draft,
      current: third.value,
      direction: -1,
    })?.value).toBe('oldest')
  })

  it('walks forward and restores the unsent draft', () => {
    const values = ['older', 'newest']
    const newest = navigateCommandHistory({
      values,
      cursor: -1,
      draft: '',
      current: 'unfinished draft',
      direction: -1,
    })!
    const restored = navigateCommandHistory({
      values,
      cursor: newest.cursor,
      draft: newest.draft,
      current: newest.value,
      direction: 1,
    })!
    expect(restored).toEqual({
      cursor: -1,
      draft: 'unfinished draft',
      value: 'unfinished draft',
    })
  })
})

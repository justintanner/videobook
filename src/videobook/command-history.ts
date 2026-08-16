import { recordValue } from './value-decoders'

export interface CommandHistoryPage {
  values: string[]
  offset: number
  hasMore: boolean
}

export interface CommandHistoryNavigation {
  cursor: number
  draft: string
  value: string
}

function resultText(result: unknown): string | null {
  const value = recordValue(result)
  const content = Array.isArray(value?.content) ? value.content : []
  const item = content.map(recordValue).find((candidate) => candidate?.type === 'text')
  return typeof item?.text === 'string' ? item.text : null
}

export function commandHistoryPage(value: unknown): CommandHistoryPage {
  const text = resultText(value)
  let parsed = value
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return { values: [], offset: 0, hasMore: false }
    }
  }
  const container = recordValue(parsed)
  const entries = Array.isArray(container?.entries) ? container.entries : []
  const page = recordValue(container?.page)
  return {
    values: entries.flatMap((entry) => {
      const item = recordValue(entry)
      return typeof item?.prompt === 'string' ? [item.prompt] : []
    }),
    offset: typeof page?.offset === 'number' ? page.offset : 0,
    hasMore: page?.has_more === true,
  }
}

export function navigateCommandHistory(input: {
  values: readonly string[]
  cursor: number
  draft: string
  current: string
  direction: -1 | 1
}): CommandHistoryNavigation | null {
  if (input.values.length === 0) return null
  let cursor = input.cursor
  let draft = input.draft
  if (cursor === -1) {
    if (input.direction === 1) return null
    draft = input.current
    cursor = input.values.length - 1
  } else {
    cursor += input.direction
    if (cursor < 0) cursor = 0
    if (cursor >= input.values.length) {
      return { cursor: -1, draft, value: draft }
    }
  }
  return {
    cursor,
    draft,
    value: input.values[cursor] ?? input.current,
  }
}

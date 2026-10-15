import { recordValue } from './value-decoders'

export type PromptHistoryScope = 'book' | 'library'
export type PromptHistorySurfaceFilter = 'surface' | 'all'

export interface PromptHistoryEntry {
  id: string
  surface: string
  prompt: string
  book: string
  model: string
  createdAt: number
}

export interface PromptHistoryQuery {
  bookId: string
  surface: string
  scope: PromptHistoryScope
  surfaceFilter: PromptHistorySurfaceFilter
}

const PROMPT_HISTORY_PAGE_SIZE = 200

const SURFACE_LABELS: Readonly<Record<string, string>> = {
  chat: 'chat',
  image_rewrite: 'image rewrite',
  video_rewrite: 'video rewrite',
  script_rewrite: 'script rewrite',
  post: 'post',
  image_generate: 'image',
  video_generate: 'video',
  audio_generate: 'audio',
}

function resultText(result: unknown): string | null {
  const value = recordValue(result)
  const content = Array.isArray(value?.content) ? value.content : []
  const item = content.map(recordValue).find((candidate) => candidate?.type === 'text')
  return typeof item?.text === 'string' ? item.text : null
}

function parsedResult(result: unknown): unknown {
  const text = resultText(result)
  if (!text) return result
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function entryModel(params: unknown): string {
  const value = recordValue(params)
  if (typeof value?.model === 'string' && value.model) return value.model
  if (typeof value?.tool === 'string' && value.tool) return value.tool
  return ''
}

function historyEntry(value: unknown): PromptHistoryEntry[] {
  const item = recordValue(value)
  if (!item || typeof item.prompt !== 'string' || !item.prompt.trim()) return []
  return [{
    id: String(item.id ?? ''),
    surface: typeof item.surface === 'string' ? item.surface : '',
    prompt: item.prompt,
    book: typeof item.book === 'string' ? item.book : '',
    model: entryModel(item.params),
    createdAt: typeof item.created_at === 'number' ? item.created_at : 0,
  }]
}

export function promptHistoryEntries(result: unknown): PromptHistoryEntry[] {
  const container = recordValue(parsedResult(result))
  const entries = Array.isArray(container?.entries) ? container.entries : []
  return entries.flatMap(historyEntry)
}

export function uniquePromptHistory(
  entries: readonly PromptHistoryEntry[],
): PromptHistoryEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = entry.prompt.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function filterPromptHistory(
  entries: readonly PromptHistoryEntry[],
  query: string,
): PromptHistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...entries]
  return entries.filter((entry) => entry.prompt.toLowerCase().includes(needle))
}

export function pinnedFirst(
  entries: readonly PromptHistoryEntry[],
  pins: ReadonlySet<string>,
): PromptHistoryEntry[] {
  const pinned = entries.filter((entry) => pins.has(entry.prompt))
  const rest = entries.filter((entry) => !pins.has(entry.prompt))
  return [...pinned, ...rest]
}

export function promptHistoryArgs(query: PromptHistoryQuery): Record<string, unknown> {
  return {
    book_id: query.bookId,
    scope: query.scope,
    limit: PROMPT_HISTORY_PAGE_SIZE,
    ...(query.surfaceFilter === 'surface' ? { surface: query.surface } : {}),
  }
}

export function promptHistorySurfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? surface.replaceAll('_', ' ')
}

function epochMs(createdAt: number): number {
  return createdAt < 1e12 ? createdAt * 1000 : createdAt
}

export function promptHistoryAge(createdAt: number, now: number): string {
  if (!createdAt) return ''
  const minutes = Math.max(0, Math.floor((now - epochMs(createdAt)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

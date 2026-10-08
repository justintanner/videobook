import { useRef, useState, type KeyboardEvent } from 'react'
import {
  promptHistoryArgs,
  promptHistoryEntries,
  uniquePromptHistory,
  type PromptHistoryEntry,
  type PromptHistoryQuery,
  type PromptHistoryScope,
  type PromptHistorySurfaceFilter,
} from './generation-prompt-history'

const PINS_STORAGE_KEY = 'videobook.prompt-history.pins'

export type PromptHistoryCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>

export interface PromptHistoryOptions {
  call: PromptHistoryCall | undefined
  bookId: string
  surface: string | null
  prompt: string
  onApply: (prompt: string) => void
}

export interface PromptHistoryControl {
  available: boolean
  open: boolean
  loading: boolean
  error: string | null
  entries: readonly PromptHistoryEntry[] | null
  loadedAt: number
  scope: PromptHistoryScope
  surfaceFilter: PromptHistorySurfaceFilter
  surface: string
  query: string
  pins: ReadonlySet<string>
  stepping: boolean
  position: number
  canOlder: boolean
  canNewer: boolean
  toggleOpen: () => void
  close: () => void
  setQuery: (query: string) => void
  setScope: (scope: PromptHistoryScope) => void
  setSurfaceFilter: (filter: PromptHistorySurfaceFilter) => void
  togglePin: (prompt: string) => void
  use: (prompt: string) => void
  older: () => void
  newer: () => void
  handlePromptKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

function readPins(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PINS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function writePins(pins: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify([...pins]))
  } catch {
    return
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function usePromptHistory({
  call,
  bookId,
  surface,
  prompt,
  onApply,
}: PromptHistoryOptions): PromptHistoryControl {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<PromptHistoryEntry[] | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)
  const [scope, setScopeState] = useState<PromptHistoryScope>('book')
  const [surfaceFilter, setSurfaceFilterState] = useState<PromptHistorySurfaceFilter>('surface')
  const [query, setQuery] = useState('')
  const [pins, setPins] = useState<ReadonlySet<string>>(readPins)
  const [cursor, setCursor] = useState(-1)
  const [draft, setDraft] = useState('')
  const requestRef = useRef(0)
  const available = Boolean(call && bookId && surface)
  const stepping = cursor >= 0 && entries?.[cursor]?.prompt === prompt
  const effectiveCursor = stepping ? cursor : -1

  const load = async (
    nextScope: PromptHistoryScope,
    nextFilter: PromptHistorySurfaceFilter,
  ): Promise<PromptHistoryEntry[] | null> => {
    if (!call || !bookId || !surface) return null
    const request = requestRef.current + 1
    requestRef.current = request
    const historyQuery: PromptHistoryQuery = {
      bookId,
      surface,
      scope: nextScope,
      surfaceFilter: nextFilter,
    }
    setLoading(true)
    setError(null)
    try {
      const loaded = uniquePromptHistory(
        promptHistoryEntries(await call('list_prompt_history', promptHistoryArgs(historyQuery))),
      )
      if (requestRef.current !== request) return null
      setEntries(loaded)
      setLoadedAt(Date.now())
      return loaded
    } catch (cause) {
      if (requestRef.current === request) setError(errorMessage(cause))
      return null
    } finally {
      if (requestRef.current === request) setLoading(false)
    }
  }

  const stepTo = (list: readonly PromptHistoryEntry[], next: number, savedDraft: string) => {
    if (next < 0) {
      setCursor(-1)
      onApply(savedDraft)
      return
    }
    const entry = list[next]
    if (!entry) return
    setCursor(next)
    onApply(entry.prompt)
  }

  const older = () => {
    if (!available) return
    if (effectiveCursor >= 0 && entries) {
      stepTo(entries, effectiveCursor + 1, draft)
      return
    }
    const savedDraft = prompt
    setDraft(savedDraft)
    void load(scope, surfaceFilter).then((loaded) => {
      if (loaded) stepTo(loaded, 0, savedDraft)
    })
  }

  const newer = () => {
    if (!stepping || !entries) return
    stepTo(entries, effectiveCursor - 1, draft)
  }

  const restoreDraft = () => {
    setCursor(-1)
    onApply(draft)
  }

  const toggleOpen = () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setQuery('')
    void load(scope, surfaceFilter)
  }

  const setScope = (next: PromptHistoryScope) => {
    setScopeState(next)
    setCursor(-1)
    void load(next, surfaceFilter)
  }

  const setSurfaceFilter = (next: PromptHistorySurfaceFilter) => {
    setSurfaceFilterState(next)
    setCursor(-1)
    void load(scope, next)
  }

  const togglePin = (value: string) => {
    const next = new Set(pins)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setPins(next)
    writePins(next)
  }

  const use = (value: string) => {
    setCursor(-1)
    setOpen(false)
    onApply(value)
  }

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault()
      older()
      return true
    }
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault()
      newer()
      return true
    }
    if (event.key === 'Escape' && stepping) {
      event.preventDefault()
      event.stopPropagation()
      restoreDraft()
      return true
    }
    return false
  }

  return {
    available,
    open,
    loading,
    error,
    entries,
    loadedAt,
    scope,
    surfaceFilter,
    surface: surface ?? '',
    query,
    pins,
    stepping,
    position: effectiveCursor + 1,
    canOlder: available && (entries === null || !stepping || effectiveCursor < entries.length - 1),
    canNewer: stepping,
    toggleOpen,
    close: () => setOpen(false),
    setQuery,
    setScope,
    setSurfaceFilter,
    togglePin,
    use,
    older,
    newer,
    handlePromptKeyDown,
  }
}

import { useCallback, useState } from 'react'
import type { NotebookGridSlot } from 'videobook-engine'

export function lastWorkScopeKey(
  bookId: string | null | undefined,
  notebookId: string | null | undefined,
): string | null {
  if (!bookId || !notebookId) return null
  return `${bookId}:${notebookId}`
}

export function lastWorkSlotForScope(
  slots: Readonly<Record<string, NotebookGridSlot>>,
  scopeKey: string | null,
): NotebookGridSlot | null {
  if (!scopeKey) return null
  return slots[scopeKey] ?? null
}

export function withLastWorkSlot(
  slots: Readonly<Record<string, NotebookGridSlot>>,
  scopeKey: string | null,
  slot: NotebookGridSlot,
): Record<string, NotebookGridSlot> {
  if (!scopeKey) return { ...slots }
  const existing = slots[scopeKey]
  if (
    existing
    && existing.row === slot.row
    && existing.column === slot.column
  ) {
    return slots as Record<string, NotebookGridSlot>
  }
  return { ...slots, [scopeKey]: slot }
}

export function useLastWorkSlot(
  bookId: string | null | undefined,
  notebookId: string | null | undefined,
): {
  lastWorkSlot: NotebookGridSlot | null
  rememberLastWorkSlot: (slot: NotebookGridSlot) => void
} {
  const [slots, setSlots] = useState<Record<string, NotebookGridSlot>>({})
  const scopeKey = lastWorkScopeKey(bookId, notebookId)
  const lastWorkSlot = lastWorkSlotForScope(slots, scopeKey)
  const rememberLastWorkSlot = useCallback((slot: NotebookGridSlot) => {
    setSlots((current) => withLastWorkSlot(current, scopeKey, slot))
  }, [scopeKey])
  return { lastWorkSlot, rememberLastWorkSlot }
}

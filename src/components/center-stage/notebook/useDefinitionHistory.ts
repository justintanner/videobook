import { useCallback, useEffect, useRef, useState } from 'react'
import type { NotebookPlanDefinition } from './types'

const HISTORY_LIMIT = 50
const COALESCE_MS = 500

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable
}

export function useDefinitionHistory(
  onDefinitionChange: (definition: NotebookPlanDefinition) => void,
) {
  const currentRef = useRef<NotebookPlanDefinition | null>(null)
  const undoRef = useRef<NotebookPlanDefinition[]>([])
  const redoRef = useRef<NotebookPlanDefinition[]>([])
  const coalesceRef = useRef<{ key: string; at: number } | null>(null)
  const [version, setVersion] = useState(0)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const publishAvailability = useCallback(() => {
    setCanUndo(undoRef.current.length > 0)
    setCanRedo(redoRef.current.length > 0)
  }, [])

  const reset = useCallback((definition: NotebookPlanDefinition | null) => {
    currentRef.current = definition
    undoRef.current = []
    redoRef.current = []
    coalesceRef.current = null
    publishAvailability()
    setVersion((value) => value + 1)
  }, [publishAvailability])

  const commit = useCallback((next: NotebookPlanDefinition, coalesceKey?: string) => {
    const current = currentRef.current
    if (!current || current === next) return
    const now = Date.now()
    const previousCoalesce = coalesceRef.current
    const canCoalesce = Boolean(coalesceKey)
      && previousCoalesce?.key === coalesceKey
      && now - (previousCoalesce?.at ?? 0) <= COALESCE_MS
    if (!canCoalesce) {
      undoRef.current = [...undoRef.current, current].slice(-HISTORY_LIMIT)
    }
    currentRef.current = next
    redoRef.current = []
    coalesceRef.current = coalesceKey ? { key: coalesceKey, at: now } : null
    publishAvailability()
    onDefinitionChange(next)
    setVersion((value) => value + 1)
  }, [onDefinitionChange, publishAvailability])

  const undo = useCallback(() => {
    const current = currentRef.current
    const previous = undoRef.current.at(-1)
    if (!current || !previous) return
    undoRef.current = undoRef.current.slice(0, -1)
    redoRef.current = [...redoRef.current, current].slice(-HISTORY_LIMIT)
    currentRef.current = previous
    coalesceRef.current = null
    publishAvailability()
    onDefinitionChange(previous)
    setVersion((value) => value + 1)
  }, [onDefinitionChange, publishAvailability])

  const redo = useCallback(() => {
    const current = currentRef.current
    const next = redoRef.current.at(-1)
    if (!current || !next) return
    redoRef.current = redoRef.current.slice(0, -1)
    undoRef.current = [...undoRef.current, current].slice(-HISTORY_LIMIT)
    currentRef.current = next
    coalesceRef.current = null
    publishAvailability()
    onDefinitionChange(next)
    setVersion((value) => value + 1)
  }, [onDefinitionChange, publishAvailability])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || isEditableTarget(event.target)) return
      if (event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [redo, undo])

  return {
    reset,
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    version,
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { wrapDefinition } from 'sequential-workflow-designer-react'
import type { WrappedDefinition } from 'sequential-workflow-designer-react'
import { createEmptyDefinition } from './model'
import type { NotebookPlanDefinition, NotebookPlanResponse } from './types'

export type NotebookSaveState = 'loading' | 'saved' | 'saving' | 'error'

interface UseNotebookPlanOptions {
  projectSlug: string
  callTool: UseMcpResult['callTool']
}

function responseText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

function toDefinition(value: unknown): NotebookPlanDefinition {
  if (typeof value !== 'object' || value === null) return createEmptyDefinition()
  const response = value as Partial<NotebookPlanResponse>
  if (!response.definition || !Array.isArray(response.definition.sequence)) return createEmptyDefinition()
  return response.definition
}

export function useNotebookPlan({ projectSlug, callTool }: UseNotebookPlanOptions) {
  const [wrapped, setWrapped] = useState<WrappedDefinition<NotebookPlanDefinition> | null>(null)
  const [saveState, setSaveState] = useState<NotebookSaveState>('loading')
  const [error, setError] = useState<string | null>(null)
  const callToolRef = useRef(callTool)
  const lastSavedJsonRef = useRef('')
  const pendingDefinitionRef = useRef<NotebookPlanDefinition | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  callToolRef.current = callTool

  const write = useCallback(async (definition: NotebookPlanDefinition) => {
    const serialized = JSON.stringify(definition)
    if (serialized === lastSavedJsonRef.current) {
      setSaveState('saved')
      return
    }
    setSaveState('saving')
    setError(null)
    try {
      const result = await callToolRef.current('write_plan', {
        project_slug: projectSlug,
        definition,
      })
      if (result.isError) throw new Error(responseText(result) || 'Unable to save Plan')
      lastSavedJsonRef.current = serialized
      setSaveState('saved')
    } catch (cause) {
      setSaveState('error')
      setError(cause instanceof Error ? cause.message : 'Unable to save Plan')
    }
  }, [projectSlug])

  const flush = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingDefinitionRef.current
    pendingDefinitionRef.current = null
    if (pending) void write(pending)
  }, [write])

  const scheduleSave = useCallback((definition: NotebookPlanDefinition) => {
    pendingDefinitionRef.current = definition
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const pending = pendingDefinitionRef.current
      pendingDefinitionRef.current = null
      if (pending) void write(pending)
    }, 1500)
  }, [write])

  const onDefinitionChange = useCallback((next: WrappedDefinition<NotebookPlanDefinition>) => {
    setWrapped(next)
    scheduleSave(next.value)
  }, [scheduleSave])

  useEffect(() => {
    let cancelled = false
    setWrapped(null)
    setSaveState('loading')
    setError(null)
    void (async () => {
      try {
        const result = await callToolRef.current('read_plan', { project_slug: projectSlug })
        if (result.isError) throw new Error(responseText(result) || 'Unable to load Plan')
        const parsed = JSON.parse(responseText(result)) as unknown
        const definition = toDefinition(parsed)
        if (cancelled) return
        lastSavedJsonRef.current = JSON.stringify(definition)
        setWrapped(wrapDefinition(definition))
        setSaveState('saved')
      } catch (cause) {
        if (cancelled) return
        const definition = createEmptyDefinition()
        lastSavedJsonRef.current = JSON.stringify(definition)
        setWrapped(wrapDefinition(definition))
        setSaveState('error')
        setError(cause instanceof Error ? cause.message : 'Unable to load Plan')
      }
    })()
    return () => {
      cancelled = true
      flush()
    }
  }, [projectSlug, flush])

  return {
    wrapped,
    saveState,
    error,
    onDefinitionChange,
    flush,
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { createEmptyDefinition, normalizeDefinition } from './model'
import type { NotebookPlanDefinition, NotebookPlanResponse } from './types'

export type NotebookSaveState = 'loading' | 'saved' | 'saving' | 'error'

interface UseNotebookPlanOptions {
  notebookId: string
  projectSlug: string
  callTool: UseMcpResult['callTool']
  mcpState: UseMcpResult['state']
}

// The notebook mounts in the center-stage when a notebook asset is selected.
// The unmount flush and the next mount's read_notebook would otherwise race on the stateless server; the new
// mount awaits the previous instance's in-flight write before reading.
const pendingPlanWrites = new Map<string, Promise<void>>()

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

export function useNotebookPlan({ notebookId, projectSlug, callTool, mcpState }: UseNotebookPlanOptions) {
  const [definition, setDefinitionState] = useState<NotebookPlanDefinition | null>(null)
  const [captures, setCaptures] = useState<NotebookPlanResponse['captures']>()
  const [captureLayout, setCaptureLayout] = useState<NotebookPlanResponse['capture_layout']>()
  const [saveState, setSaveState] = useState<NotebookSaveState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [legacy, setLegacy] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const [loadedDefinition, setLoadedDefinition] = useState<NotebookPlanDefinition | null>(null)
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
    const attempt = (async () => {
      const result = await callToolRef.current('write_notebook', {
        project_slug: projectSlug,
        notebook_id: notebookId,
        definition,
      })
      if (result.isError) throw new Error(responseText(result) || 'Unable to save Notebook')
    })()
    const tracked = attempt.catch(() => {})
    const key = `${projectSlug}:${notebookId}`
    pendingPlanWrites.set(key, tracked)
    void tracked.then(() => {
      if (pendingPlanWrites.get(key) === tracked) pendingPlanWrites.delete(key)
    })
    try {
      await attempt
      lastSavedJsonRef.current = serialized
      setLegacy(false)
      setSaveState('saved')
    } catch (cause) {
      setSaveState('error')
      setError(cause instanceof Error ? cause.message : 'Unable to save Notebook')
    }
  }, [projectSlug, notebookId])

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

  const setDefinition = useCallback((next: NotebookPlanDefinition) => {
    setDefinitionState(next)
    scheduleSave(next)
  }, [scheduleSave])

  useEffect(() => {
    if (mcpState !== 'ready') return
    let cancelled = false
    setDefinitionState(null)
    setLoadedDefinition(null)
    setCaptures(undefined)
    setCaptureLayout(undefined)
    setSaveState('loading')
    setError(null)
    setLegacy(false)
    void (async () => {
      try {
        const key = `${projectSlug}:${notebookId}`
        const pending = pendingPlanWrites.get(key)
        if (pending) await pending
        const result = await callToolRef.current('read_notebook', { project_slug: projectSlug, notebook_id: notebookId })
        if (result.isError) throw new Error(responseText(result) || 'Unable to load Notebook')
        const parsed = JSON.parse(responseText(result)) as unknown
        const loaded = toDefinition(parsed)
        if (cancelled) return
        const response = parsed as Partial<NotebookPlanResponse>
        
        // Also call activate_notebook to share persisted capture target
        void callToolRef.current('activate_notebook', { project_slug: projectSlug, notebook_id: notebookId })

        setLegacy(response.legacy === true)
        setCaptures(response.captures)
        setCaptureLayout(response.capture_layout)
        const normalized = normalizeDefinition(loaded)
        lastSavedJsonRef.current = JSON.stringify(loaded)
        setDefinitionState(normalized.definition)
        setLoadedDefinition(normalized.definition)
        if (normalized.changed) scheduleSave(normalized.definition)
        setLoadVersion((version) => version + 1)
        setSaveState('saved')
      } catch (cause) {
        if (cancelled) return
        // Leave `definition` null: a failed load must not hand the user an
        // editable empty notebook whose first save overwrites the real plan.
        setSaveState('error')
        setError(cause instanceof Error ? cause.message : 'Unable to load Notebook')
      }
    })()
    return () => {
      cancelled = true
      flush()
    }
  }, [projectSlug, notebookId, mcpState, flush, scheduleSave])

  return {
    definition,
    captures,
    captureLayout,
    saveState,
    error,
    legacy,
    loadVersion,
    loadedDefinition,
    setDefinition,
    flush,
  }
}


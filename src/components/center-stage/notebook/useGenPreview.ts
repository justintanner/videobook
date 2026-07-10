import { useCallback, useEffect, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import type { FullPreviewResponse } from '@/components/gen/types'

interface UseGenPreviewOptions {
  category: 'image' | 'video'
  projectSlug: string
  callTool: UseMcpResult['callTool']
  model: string
  provider: string
}

function previewToolName(category: 'image' | 'video'): string {
  return category === 'image' ? 'preview_image' : 'preview_video'
}

function responseText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

export function useGenPreview({ category, projectSlug, callTool, model, provider }: UseGenPreviewOptions) {
  const [preview, setPreview] = useState<FullPreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState({ model, provider })
  const requestIdRef = useRef(0)
  const callToolRef = useRef(callTool)
  callToolRef.current = callTool

  const refresh = useCallback(async (next: { model: string; provider: string }) => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await callToolRef.current(previewToolName(category), {
        // prompt is a required arg on the preview router tools; the notebook
        // only wants the catalog/schema, so an empty prompt is correct here.
        prompt: '',
        project_slug: projectSlug,
        ...(next.model ? { selected_model: next.model } : {}),
        ...(next.provider ? { selected_provider: next.provider } : {}),
      })
      if (result.isError) throw new Error(responseText(result) || 'Unable to load generation form')
      const parsed = JSON.parse(responseText(result)) as FullPreviewResponse
      if (requestId !== requestIdRef.current) return
      setPreview(parsed)
    } catch (cause) {
      if (requestId !== requestIdRef.current) return
      setError(cause instanceof Error ? cause.message : 'Unable to load generation form')
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [category, projectSlug])

  // Selection is the single fetch trigger; equality guards keep persisted-prop
  // echoes (setProperty round-trips) and repeat picks from refetching.
  useEffect(() => {
    setSelection((prev) => (prev.model === model && prev.provider === provider ? prev : { model, provider }))
  }, [model, provider])

  useEffect(() => {
    void refresh(selection)
  }, [refresh, selection])

  const selectModel = useCallback((nextModel: string, nextProvider: string) => {
    setSelection((prev) => (
      prev.model === nextModel && prev.provider === nextProvider ? prev : { model: nextModel, provider: nextProvider }
    ))
  }, [])

  const selectedModelKey = selection.model || preview?.selected_model || ''
  const selectedOption = preview?.model_options.find((option) => option.key === selectedModelKey)
  const selectedProviderKey = selection.provider || selectedOption?.selected_provider || preview?.selected_provider || ''

  return {
    preview,
    loading,
    error,
    selectedModelKey,
    selectedProviderKey,
    selectedOption,
    selectModel,
  }
}

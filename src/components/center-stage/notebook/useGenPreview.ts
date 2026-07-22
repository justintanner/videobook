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

interface SelectionState {
  sourceModel: string
  sourceProvider: string
  model: string
  provider: string
  version: number
}

interface PreviewState {
  key: string
  preview: FullPreviewResponse | null
  error: string | null
}

function previewToolName(category: 'image' | 'video'): string {
  return category === 'image' ? 'prepare_image_generation' : 'prepare_video_generation'
}

function responseText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

export function useGenPreview({ category, projectSlug, callTool, model, provider }: UseGenPreviewOptions) {
  const [previewState, setPreviewState] = useState<PreviewState>({ key: '', preview: null, error: null })
  const [selection, setSelection] = useState<SelectionState>({
    sourceModel: model,
    sourceProvider: provider,
    model,
    provider,
    version: 0,
  })
  const requestIdRef = useRef(0)
  const callToolRef = useRef(callTool)
  const sourceMatches = selection.sourceModel === model && selection.sourceProvider === provider
  const selectionMatches = selection.model === model && selection.provider === provider
  const selectedModel = sourceMatches ? selection.model : model
  const selectedProvider = sourceMatches ? selection.provider : provider
  const selectionVersion = sourceMatches || selectionMatches ? selection.version : selection.version + 1

  if (!sourceMatches) {
    setSelection({
      sourceModel: model,
      sourceProvider: provider,
      model,
      provider,
      version: selectionVersion,
    })
  }

  const requestKey = JSON.stringify([category, projectSlug, selectedModel, selectedProvider, selectionVersion])

  useEffect(() => {
    callToolRef.current = callTool
  }, [callTool])

  const refresh = useCallback(async (next: { model: string; provider: string }, key: string) => {
    const requestId = ++requestIdRef.current
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
      setPreviewState({ key, preview: parsed, error: null })
    } catch (cause) {
      if (requestId !== requestIdRef.current) return
      setPreviewState((current) => ({
        key,
        preview: current.preview,
        error: cause instanceof Error ? cause.message : 'Unable to load generation form',
      }))
    }
  }, [category, projectSlug])

  useEffect(() => {
    void refresh({ model: selectedModel, provider: selectedProvider }, requestKey)
  }, [refresh, requestKey, selectedModel, selectedProvider])

  const selectModel = useCallback((nextModel: string, nextProvider: string) => {
    setSelection((prev) => (
      prev.model === nextModel && prev.provider === nextProvider
        ? prev
        : { ...prev, model: nextModel, provider: nextProvider, version: prev.version + 1 }
    ))
  }, [])

  const preview = previewState.preview
  const selectedModelKey = selectedModel || preview?.selected_model || ''
  const selectedOption = preview?.model_options.find((option) => option.key === selectedModelKey)
  const selectedProviderKey = selectedProvider || selectedOption?.selected_provider || preview?.selected_provider || ''

  return {
    preview,
    loading: previewState.key !== requestKey,
    error: previewState.key === requestKey ? previewState.error : null,
    selectedModelKey,
    selectedProviderKey,
    selectedOption,
    selectModel,
  }
}

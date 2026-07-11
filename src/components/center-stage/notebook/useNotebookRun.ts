import { useCallback, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { effectiveToolName, filterValuesForMode, inferModeKey } from '@/components/gen/modes'
import type { ModelOption } from '@/components/gen/types'
import { createGenerationRequestId } from '@/lib/generation-lifecycle'
import type { OnGenerationLifecycle } from '@/lib/generation-lifecycle'
import { appendRunAsset } from './model'
import type { NotebookPlanDefinition, NotebookPlanStep } from './types'

interface UseNotebookRunOptions {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  definition: NotebookPlanDefinition | null
  replaceDefinition: (definition: NotebookPlanDefinition, stepId: string) => Promise<void>
  onGenerationLifecycle?: OnGenerationLifecycle
}

function responseText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

function generationAssetId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { img_asset_id?: string; vid_asset_id?: string }
    return parsed.img_asset_id ?? parsed.vid_asset_id ?? null
  } catch {
    return null
  }
}

export interface NotebookRunSubmitArgs {
  step: NotebookPlanStep
  option: ModelOption
  provider: string
  values: Record<string, unknown>
  projectSlug: string
  callTool: UseMcpResult['callTool']
  getDefinition: () => NotebookPlanDefinition | null
  replaceDefinition: (definition: NotebookPlanDefinition, stepId: string) => Promise<void>
  onGenerationLifecycle?: OnGenerationLifecycle
}

export type NotebookRunSubmitResult =
  | { ok: true; assetId: string; requestId: string }
  | { ok: false; message: string; requestId: string }

/** Submit one generation step via MCP. Returns after enqueue (asset id), not after render. */
export async function submitNotebookGeneration(
  args: NotebookRunSubmitArgs,
): Promise<NotebookRunSubmitResult> {
  const {
    step,
    option,
    provider,
    values,
    projectSlug,
    callTool,
    getDefinition,
    replaceDefinition,
    onGenerationLifecycle,
  } = args
  const category = step.type === 'image' ? 'image' : 'video'
  const requestId = createGenerationRequestId(category)
  const storedMode = typeof step.properties.mode === 'string' ? step.properties.mode : null
  const modeKey = option.modes
    ? (storedMode && option.modes.modes.some((m) => m.key === storedMode)
      ? storedMode
      : inferModeKey(option.modes, values))
    : null
  const submitValues = option.modes && modeKey
    ? filterValuesForMode(option.modes, modeKey, values)
    : values
  const toolName = effectiveToolName(option, modeKey)
  const prompt = typeof submitValues.prompt === 'string' ? submitValues.prompt : ''
  onGenerationLifecycle?.({ phase: 'started', requestId, category, prompt })
  try {
    const result = await callTool(toolName, {
      ...submitValues,
      project_slug: projectSlug,
      _provider: provider || undefined,
    })
    if (result.isError) throw new Error(responseText(result) || 'Generation failed')
    const assetId = generationAssetId(responseText(result))
    if (!assetId) throw new Error('Generation did not return an asset id')
    const latest = getDefinition()
    if (latest) {
      await replaceDefinition(
        appendRunAsset(latest, step.id, assetId, { model: option.key, provider }),
        step.id,
      )
    }
    onGenerationLifecycle?.({ phase: 'submitted', requestId, assetId })
    return { ok: true, assetId, requestId }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Generation failed'
    onGenerationLifecycle?.({ phase: 'failed', requestId })
    return { ok: false, message, requestId }
  }
}

export function useNotebookRun({
  projectSlug,
  callTool,
  definition,
  replaceDefinition,
  onGenerationLifecycle,
}: UseNotebookRunOptions) {
  const [runningStepIds, setRunningStepIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  // Completion must patch the definition as it exists THEN, not the render
  // captured at submit — otherwise edits made (or runs finished) while this
  // generation was in flight get clobbered by replaceDefinition.
  const definitionRef = useRef(definition)
  definitionRef.current = definition
  const inFlightRef = useRef(new Set<string>())

  const run = useCallback(async (
    step: NotebookPlanStep,
    option: ModelOption,
    provider: string,
    values: Record<string, unknown>,
  ) => {
    if (!definitionRef.current || inFlightRef.current.has(step.id)) return
    inFlightRef.current.add(step.id)
    setRunningStepIds((ids) => new Set(ids).add(step.id))
    setErrors((current) => {
      const next = new Map(current)
      next.delete(step.id)
      return next
    })
    try {
      const result = await submitNotebookGeneration({
        step,
        option,
        provider,
        values,
        projectSlug,
        callTool,
        getDefinition: () => definitionRef.current,
        replaceDefinition,
        onGenerationLifecycle,
      })
      if (!result.ok) {
        setErrors((current) => new Map(current).set(step.id, result.message))
      }
    } finally {
      inFlightRef.current.delete(step.id)
      setRunningStepIds((ids) => {
        const next = new Set(ids)
        next.delete(step.id)
        return next
      })
    }
  }, [callTool, onGenerationLifecycle, projectSlug, replaceDefinition])

  return { run, runningStepIds, errors }
}

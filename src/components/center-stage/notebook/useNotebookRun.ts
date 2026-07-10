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

  const run = useCallback(async (
    step: NotebookPlanStep,
    option: ModelOption,
    provider: string,
    values: Record<string, unknown>,
  ) => {
    if (!definitionRef.current || runningStepIds.has(step.id)) return
    const category = step.type === 'image' ? 'image' : 'video'
    const requestId = createGenerationRequestId(category)
    const modeKey = option.modes ? inferModeKey(option.modes, values) : null
    const submitValues = option.modes && modeKey
      ? filterValuesForMode(option.modes, modeKey, values)
      : values
    const toolName = effectiveToolName(option, modeKey)
    const prompt = typeof submitValues.prompt === 'string' ? submitValues.prompt : ''
    setRunningStepIds((ids) => new Set(ids).add(step.id))
    setErrors((current) => {
      const next = new Map(current)
      next.delete(step.id)
      return next
    })
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
      const latest = definitionRef.current
      if (latest) {
        await replaceDefinition(
          appendRunAsset(latest, step.id, assetId, { model: option.key, provider }),
          step.id,
        )
      }
      onGenerationLifecycle?.({ phase: 'submitted', requestId, assetId })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Generation failed'
      setErrors((current) => new Map(current).set(step.id, message))
      onGenerationLifecycle?.({ phase: 'failed', requestId })
    } finally {
      setRunningStepIds((ids) => {
        const next = new Set(ids)
        next.delete(step.id)
        return next
      })
    }
  }, [callTool, onGenerationLifecycle, projectSlug, replaceDefinition, runningStepIds])

  return { run, runningStepIds, errors }
}

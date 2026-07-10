import { useEffect, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { effectiveToolName, inferModeKey } from '@/components/gen/modes'
import type { FullPreviewResponse } from '@/components/gen/types'
import type { CostEstimate } from '@/hooks/useEstimateCost'
import { shortCostLabel } from '@/lib/format-cost'
import { resolveEffectiveValues } from './model'
import type { NotebookPlanDefinition, NotebookPlanStep } from './types'

const ESTIMATE_DEBOUNCE_MS = 600
const CACHE_LIMIT = 400

interface DerivedCall {
  stepId: string
  key: string // unique per (toolName, input)
  toolName: string
  input: Record<string, unknown>
}

function responseText(result: Awaited<ReturnType<UseMcpResult['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

/**
 * Turn a gen step into the estimate_cost call that Run would issue. Mirrors the
 * editor's derivation (NotebookStepEditor `mergedValues` + `effectiveToolName`):
 * prefilled_values ⊕ step values, mode-aware tool name, project_slug appended.
 * Falls back to the category's default model when the step has none yet, so a
 * fresh cell costs out exactly as running it would. Exported for unit tests.
 */
export function deriveStepEstimateCall(
  definition: NotebookPlanDefinition,
  step: NotebookPlanStep,
  preview: FullPreviewResponse | null,
  projectSlug: string,
): DerivedCall | null {
  if (step.type === 'prompt' || step.type === 'asset' || !preview) return null
  const stepModel = typeof step.properties.model === 'string' ? step.properties.model : ''
  const model = stepModel || preview.selected_model
  const option = preview.model_options.find((candidate) => candidate.key === model)
  if (!option) return null
  const resolved = resolveEffectiveValues(definition, step, option)
  const merged = { ...option.prefilled_values, ...resolved.values }
  const storedMode = typeof step.properties.mode === 'string' ? step.properties.mode : null
  const modeKey = option.modes
    ? (storedMode && option.modes.modes.some((m) => m.key === storedMode)
      ? storedMode
      : inferModeKey(option.modes, merged))
    : null
  const toolName = effectiveToolName(option, modeKey)
  const input = { ...merged, project_slug: projectSlug }
  return { stepId: step.id, key: `${toolName} ${JSON.stringify(input)}`, toolName, input }
}

interface StepTuple {
  category: 'image' | 'video'
  model: string
  provider: string
}

function stepTuple(step: NotebookPlanStep): StepTuple | null {
  if (step.type !== 'image' && step.type !== 'video') return null
  const model = typeof step.properties.model === 'string' ? step.properties.model : ''
  const provider = typeof step.properties.provider === 'string' ? step.properties.provider : ''
  return { category: step.type, model, provider }
}

// A model's tool name is provider-specific, so previews are keyed by the full
// (category, model, provider) tuple — the same inputs useGenPreview passes for
// the editor. Fetching per-category with no provider would resolve a different
// tool than Run actually uses (e.g. a Kie default vs the cell's Google Flow).
function tupleKey(tuple: StepTuple): string {
  return `${tuple.category} ${tuple.model} ${tuple.provider}`
}

/**
 * Estimated cost per gen cell, keyed by step id, for painting onto the canvas
 * cards. Fetches one preview per distinct (category, model, provider) tuple,
 * then one batched, debounced estimate_cost per settled definition change
 * containing only cache-missing steps.
 */
export function useCanvasCostEstimates(options: {
  projectSlug: string
  callTool: UseMcpResult['callTool']
  definition: NotebookPlanDefinition | null
  enabled: boolean
}): ReadonlyMap<string, string> {
  const { projectSlug, callTool, definition, enabled } = options
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map())
  const callToolRef = useRef(callTool)
  callToolRef.current = callTool
  const previewsRef = useRef<Record<string, FullPreviewResponse | 'pending'>>({})
  const cacheRef = useRef(new Map<string, CostEstimate>())
  const requestIdRef = useRef(0)
  const [previewTick, setPreviewTick] = useState(0)

  // A project switch invalidates the model catalogs, the estimate cache, and
  // the labels.
  useEffect(() => {
    previewsRef.current = {}
    cacheRef.current = new Map()
    setLabels(new Map())
  }, [projectSlug])

  // Lazily fetch one preview per distinct (category, model, provider) the plan
  // uses — mirroring useGenPreview so the card resolves the exact tool Run will.
  useEffect(() => {
    if (!enabled || !definition) return
    const tuples = new Map<string, StepTuple>()
    for (const step of definition.sequence) {
      const tuple = stepTuple(step)
      if (tuple) tuples.set(tupleKey(tuple), tuple)
    }
    for (const [key, tuple] of tuples) {
      if (previewsRef.current[key]) continue
      previewsRef.current[key] = 'pending'
      void (async () => {
        try {
          const result = await callToolRef.current(
            tuple.category === 'image' ? 'preview_image' : 'preview_video',
            {
              prompt: '',
              project_slug: projectSlug,
              ...(tuple.model ? { selected_model: tuple.model } : {}),
              ...(tuple.provider ? { selected_provider: tuple.provider } : {}),
            },
          )
          if (result.isError) throw new Error('preview failed')
          previewsRef.current[key] = JSON.parse(responseText(result)) as FullPreviewResponse
          setPreviewTick((tick) => tick + 1) // re-run the estimate pass
        } catch {
          delete previewsRef.current[key] // retried on the next definition change
        }
      })()
    }
  }, [enabled, definition, projectSlug])

  // Debounced estimate pass. The definition identity changes per keystroke in
  // the sidebar (only write_plan is debounced, not the in-memory state), so the
  // debounce + per-key cache keep estimate_cost traffic to one batched call per
  // settled edit.
  useEffect(() => {
    if (!enabled || !definition) return
    const requestId = ++requestIdRef.current
    const timer = setTimeout(() => {
      void (async () => {
        const next = new Map<string, string>()
        const missing: DerivedCall[] = []
        for (const step of definition.sequence) {
          const tuple = stepTuple(step)
          const preview = tuple ? previewsRef.current[tupleKey(tuple)] : undefined
          const derived = deriveStepEstimateCall(
            definition,
            step,
            preview && preview !== 'pending' ? preview : null,
            projectSlug,
          )
          if (!derived) continue
          const cached = cacheRef.current.get(derived.key)
          if (cached) next.set(derived.stepId, shortCostLabel(cached))
          else missing.push(derived)
        }
        if (missing.length > 0) {
          const unique = [...new Map(missing.map((call) => [call.key, call])).values()]
          try {
            const result = await callToolRef.current('estimate_cost', {
              calls: unique.map((call) => ({ tool_name: call.toolName, input: call.input })),
            })
            if (!result.isError) {
              const parsed = JSON.parse(responseText(result)) as { per_call: Array<{ estimate: CostEstimate }> }
              unique.forEach((call, index) => {
                const estimate = parsed.per_call[index]?.estimate
                if (estimate) cacheRef.current.set(call.key, estimate)
              })
              if (cacheRef.current.size > CACHE_LIMIT) cacheRef.current = new Map()
              for (const call of missing) {
                const estimate = cacheRef.current.get(call.key)
                if (estimate) next.set(call.stepId, shortCostLabel(estimate))
              }
            }
          } catch {
            // Leave uncached; the next definition change retries.
          }
        }
        if (requestId !== requestIdRef.current) return
        setLabels((prev) => {
          if (prev.size === next.size && [...next].every(([id, label]) => prev.get(id) === label)) return prev
          return next
        })
      })()
    }, ESTIMATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, definition, projectSlug, previewTick])

  return labels
}

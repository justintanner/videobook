import { useCallback, useRef, useState } from 'react'
import type { UseMcpResult } from 'use-mcp/react'
import { effectiveToolName, filterValuesForMode, inferModeKey } from '@/components/gen/modes'
import type { ModelOption } from '@/components/gen/types'
import { createGenerationRequestId } from '@/lib/generation-lifecycle'
import type { OnGenerationLifecycle } from '@/lib/generation-lifecycle'
import { rewriteCharacterMentions, stripOrphanedReferenceMarkers } from '@/components/ui/richPromptTokens'
import { canonicalCharacterId } from '@/components/gen/ui/media-strip'
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
  charMentions?: { handle: string; n: number }[]
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
  const submitValues = {
    ...(option.modes && modeKey
      ? filterValuesForMode(option.modes, modeKey, values)
      : values)
  }
  const toolName = effectiveToolName(option, modeKey)
  
  if (args.charMentions && option.schema.properties.character_refs) {
    const rawPrompt = typeof submitValues.prompt === 'string' ? submitValues.prompt : ''
    const rewritten = rewriteCharacterMentions(rawPrompt, args.charMentions)
    const charCount = Array.isArray(submitValues.character_refs) ? (submitValues.character_refs as unknown[]).length : 0
    const imgCount = Array.isArray(submitValues.image_slugs) ? (submitValues.image_slugs as unknown[]).length : 0
    const voiceCount = Array.isArray(submitValues.voice_refs) ? (submitValues.voice_refs as unknown[]).length : 0
    submitValues.prompt = stripOrphanedReferenceMarkers(rewritten, {
      character: charCount,
      referenceImage: imgCount,
      referenceAudio: voiceCount,
    })
  }
  
  if (Array.isArray(submitValues._pending_character_slugs) && submitValues._pending_character_slugs.length > 0) {
    const pendingSlugs = submitValues._pending_character_slugs as string[]
    delete submitValues._pending_character_slugs
    
    let cacheUpdates: Record<string, string> | null = null
    const charRefs = Array.isArray(submitValues.character_refs) ? [...(submitValues.character_refs as string[])] : []
    
    for (const slug of pendingSlugs) {
      onGenerationLifecycle?.({ phase: 'started', requestId: `char_${slug}`, category: 'image', prompt: `Creating character for ${slug}` })
      try {
        const charResult = await callTool('create_google_flow_character', {
          project_slug: projectSlug,
          display_name: slug,
          image_slugs: [slug],
        })
        if (charResult.isError) throw new Error(responseText(charResult) || 'Character creation failed')
        const parsed = JSON.parse(responseText(charResult)) as { character_ref?: string }
        if (parsed.character_ref) {
          charRefs.push(parsed.character_ref)
          cacheUpdates = cacheUpdates || {}
          cacheUpdates[slug] = parsed.character_ref
        }
      } catch (err) {
        throw new Error(`Failed to create character for ${slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    
    submitValues.character_refs = charRefs
    if (cacheUpdates) {
      const latest = getDefinition()
      if (latest) {
        const targetStep = latest.sequence.find(s => s.id === step.id)
        if (targetStep) {
          const currentCache = (targetStep.properties.character_cache as Record<string, unknown>) ?? {}
          await replaceDefinition({
            ...latest,
            sequence: latest.sequence.map(s => s.id === step.id ? {
              ...s,
              properties: {
                ...s.properties,
                character_cache: { ...currentCache, ...cacheUpdates } as Record<string, unknown>
              }
            } : s) as NotebookPlanStep[]
          }, step.id)
        }
      }
    }
  }

  if (Array.isArray(submitValues.character_refs) && submitValues.character_refs.length > 0) {
    try {
      const listResult = await callTool('list_google_flow_characters', { include_previews: false })
      if (!listResult.isError) {
        const parsed = JSON.parse(responseText(listResult)) as { characters: { ref: string; display_name?: string }[] }
        if (parsed.characters) {
          const canonicalToLive = new Map<string, string>()
          const canonicalToName = new Map<string, string>()
          for (const char of parsed.characters) {
            const canonical = canonicalCharacterId(char.ref)
            canonicalToLive.set(canonical, char.ref)
            canonicalToName.set(canonical, char.display_name ?? canonical)
          }
          const updatedRefs = (submitValues.character_refs as string[]).map((ref) => {
            if (!ref.trim()) return ref
            const canonical = canonicalCharacterId(ref)
            const liveRef = canonicalToLive.get(canonical)
            if (!liveRef) {
              const name = canonicalToName.get(canonical) ?? ref
              throw new Error(`Character not found upstream: ${name}`)
            }
            return liveRef
          })
          submitValues.character_refs = updatedRefs
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onGenerationLifecycle?.({ phase: 'failed', requestId })
      return { ok: false, message, requestId }
    }
  }
  
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
    charMentions?: { handle: string; n: number }[]
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
        charMentions,
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

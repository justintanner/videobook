import type { ModelOption } from '@/components/gen/types'
import { rewriteCharacterMentions, stripOrphanedReferenceMarkers } from '@/components/ui/richPromptTokens'

export interface NotebookCharMention {
  handle: string
  n: number
}

export interface TransformNotebookSubmitArgsParams {
  option: ModelOption
  values: Record<string, unknown>
  charMentions?: NotebookCharMention[]
}

/** Apply the synchronous submit-time prompt transforms so the sidebar preview
 *  and the wire payload match by construction. Mirrors the rewrite that
 *  `submitNotebookGeneration` historically applied only at submit, so a Google
 *  Flow step with `@<handle>` character mentions previews exactly as it will
 *  submit (rewritten to `@character_N` and stripped of orphaned markers).
 *
 *  Async transforms (pending-character creation, character_ref resolution) stay
 *  in the submit path — they require live MCP calls the preview cannot make,
 *  and the preview is honest when it shows the unresolved state. */
export function transformNotebookSubmitArgs(
  params: TransformNotebookSubmitArgsParams,
): Record<string, unknown> {
  const { option, values, charMentions } = params
  if (!charMentions || !option.schema.properties.character_refs) {
    return { ...values }
  }
  const rawPrompt = typeof values.prompt === 'string' ? values.prompt : ''
  const rewritten = rewriteCharacterMentions(rawPrompt, charMentions)
  const charCount = Array.isArray(values.character_refs) ? (values.character_refs as unknown[]).length : 0
  const imgCount = Array.isArray(values.image_slugs) ? (values.image_slugs as unknown[]).length : 0
  const voiceCount = Array.isArray(values.voice_refs) ? (values.voice_refs as unknown[]).length : 0
  const prompt = stripOrphanedReferenceMarkers(rewritten, {
    character: charCount,
    referenceImage: imgCount,
    referenceAudio: voiceCount,
  })
  return { ...values, prompt }
}

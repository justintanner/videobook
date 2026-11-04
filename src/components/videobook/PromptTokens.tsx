import type { RefObject } from 'react'
import type { PromptTokenSources } from '@/videobook/prompt-tokens'
import { generationInputTokenPattern } from '../../../server/src/generation-input-targets'

type PromptPart = {
  offset: number
  text: string
  token: string | null
}

function promptParts(prompt: string): PromptPart[] {
  const parts: PromptPart[] = []
  let last = 0
  for (const match of prompt.matchAll(generationInputTokenPattern())) {
    const offset = match.index ?? 0
    if (offset > last) parts.push({ offset: last, text: prompt.slice(last, offset), token: null })
    parts.push({ offset, text: match[0], token: match[1]!.toLowerCase() })
    last = offset + match[0].length
  }
  if (last < prompt.length) parts.push({ offset: last, text: prompt.slice(last), token: null })
  return parts
}

export function PromptTokenLayer({
  layerRef,
  prompt,
  sources,
}: {
  layerRef: RefObject<HTMLDivElement | null>
  prompt: string
  sources: PromptTokenSources
}) {
  return (
    <div className="prompt-token-layer" ref={layerRef} aria-hidden="true">
      {promptParts(prompt).map((part) => part.token
        ? <mark key={part.offset} className="prompt-token" data-known={sources.has(part.token) ? 'true' : undefined}>{part.text}</mark>
        : <span key={part.offset}>{part.text}</span>)}
      {' '}
    </div>
  )
}

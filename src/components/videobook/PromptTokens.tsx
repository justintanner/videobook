import type { RefObject } from 'react'
import { MediaLibraryAssetPreview } from '@/components/videobook/MediaLibraryAssetPreview'
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

export function PromptTokenStrip({ prompt, sources }: { prompt: string; sources: PromptTokenSources }) {
  const used = [...new Set(promptParts(prompt).flatMap((part) => part.token ? [part.token] : []))]
  if (used.length === 0) return null
  return (
    <div className="prompt-token-strip" aria-label="Prompt inputs">
      {used.map((token) => {
        const source = sources.get(token)
        return (
          <span
            key={token}
            className="prompt-token-pill"
            data-known={source ? 'true' : undefined}
            title={source ? `@${token} is @${source.address}` : `@${token} names no connected input`}
          >
            <span className="prompt-token-thumb">
              {source && (
                <MediaLibraryAssetPreview
                  asset={source.asset ?? { type: source.type, mediaUrl: null, thumbnailUrl: null, duration: null }}
                  eager
                />
              )}
            </span>
            <strong>@{token}</strong>
            {source && <small>@{source.address}</small>}
          </span>
        )
      })}
    </div>
  )
}

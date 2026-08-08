import type { ReactNode } from 'react'
import {
  ArtifactThumb,
  type ArtifactThumbAsset,
} from './ArtifactThumb'

interface JsonToken {
  kind: 'boolean' | 'key' | 'null' | 'number' | 'punctuation' | 'string'
  value: string
}

const jsonTokenPattern =
  /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function tokenizeJson(value: unknown): JsonToken[] {
  const source = JSON.stringify(value, null, 2) ?? 'null'
  const tokens: JsonToken[] = []
  let cursor = 0

  for (const match of source.matchAll(jsonTokenPattern)) {
    const index = match.index
    if (index > cursor) {
      tokens.push({
        kind: 'punctuation',
        value: source.slice(cursor, index),
      })
    }
    tokens.push({
      kind: match[1]
        ? 'key'
        : match[2]
          ? 'string'
          : match[3]
            ? 'boolean'
            : match[4]
              ? 'null'
              : 'number',
      value: match[0],
    })
    cursor = index + match[0].length
  }

  if (cursor < source.length) {
    tokens.push({
      kind: 'punctuation',
      value: source.slice(cursor),
    })
  }

  return tokens
}

function unquotedStringToken(value: string): string | null {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
    return null
  }
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function RichJson({
  value,
  ariaLabel = 'Formatted action source',
  artifactAssets,
}: {
  value: unknown
  ariaLabel?: string
  artifactAssets?: ReadonlyMap<string, ArtifactThumbAsset>
}) {
  const tokens = tokenizeJson(value)

  return (
    <pre className="inspector-source-json" aria-label={ariaLabel}>
      {tokens.map((token, index): ReactNode => {
        const unquoted = token.kind === 'string'
          ? unquotedStringToken(token.value)
          : null
        const asset = unquoted && artifactAssets
          ? artifactAssets.get(unquoted)
          : undefined
        return (
          <span className={`json-${token.kind}`} key={`${index}-${token.value}`}>
            {token.value}
            {asset ? <ArtifactThumb asset={asset} /> : null}
          </span>
        )
      })}
    </pre>
  )
}

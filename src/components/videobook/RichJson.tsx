import { useId, useRef, type ReactNode } from 'react'
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

function JsonMediaPreview({ asset }: { asset: ArtifactThumbAsset }) {
  const id = useId()
  const previewRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const video = asset.type === 'video' || asset.type === 'final'
  const mediaUrl = asset.mediaUrl ?? (asset.type === 'image' ? asset.thumbnailUrl : null)
  if (!mediaUrl || (!video && asset.type !== 'image' && asset.type !== 'audio')) {
    return <ArtifactThumb asset={asset} />
  }

  const showPreview = () => {
    const preview = previewRef.current
    const trigger = triggerRef.current
    if (!preview || !trigger) return
    preview.showPopover()
    const anchor = trigger.getBoundingClientRect()
    const bounds = preview.getBoundingClientRect()
    const left = anchor.right + bounds.width <= window.innerWidth - 12
      ? anchor.right
      : Math.max(12, anchor.left - bounds.width)
    preview.style.left = `${left}px`
    preview.style.top = `${Math.max(12, Math.min(anchor.top, window.innerHeight - bounds.height - 12))}px`
  }
  const hidePreview = () => previewRef.current?.hidePopover()

  return (
    <span
      className="json-media-preview"
      onMouseEnter={showPreview}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) hidePreview()
      }}
      onFocus={showPreview}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hidePreview()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="json-media-trigger"
        aria-label={`Preview source ${video ? 'video' : asset.type}`}
        aria-controls={id}
        onClick={showPreview}
      >
        <ArtifactThumb asset={asset} videoFrame />
      </button>
      <span
        id={id}
        ref={previewRef}
        popover="auto"
        className="json-media-popover"
        onToggle={(event) => {
          if (event.newState !== 'closed') return
          event.currentTarget.querySelectorAll('video, audio').forEach((media) => {
            if (media instanceof HTMLMediaElement) media.pause()
          })
        }}
      >
        {asset.type === 'image'
          ? <img src={mediaUrl} alt="Source image preview" loading="lazy" decoding="async" />
          : video
            ? <video src={mediaUrl} poster={asset.thumbnailUrl ?? undefined} controls playsInline preload="none" aria-label="Source video" />
            : <audio src={mediaUrl} controls preload="none" aria-label="Source audio" />}
      </span>
    </span>
  )
}

const remoteImagePattern = /\.(?:png|jpe?g|webp|gif|avif)$/i
const remoteVideoPattern = /\.(?:mp4|mov|webm|m4v)$/i

/** A media asset for a bare http(s) URL whose path names an image or video. */
function remoteMediaAsset(value: string): ArtifactThumbAsset | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined
  let pathname: string
  try {
    pathname = new URL(value).pathname
  } catch {
    return undefined
  }
  const type = remoteImagePattern.test(pathname)
    ? 'image'
    : remoteVideoPattern.test(pathname) ? 'video' : null
  return type ? { artifactId: value, type, mediaUrl: value } : undefined
}

export function RichJson({
  value,
  ariaLabel = 'Formatted action source',
  artifactAssets,
  mediaDisplay = 'thumbnail',
  remoteMedia = false,
}: {
  value: unknown
  ariaLabel?: string
  artifactAssets?: ReadonlyMap<string, ArtifactThumbAsset>
  mediaDisplay?: 'thumbnail' | 'preview'
  /** Also preview http(s) strings that point at image or video files. */
  remoteMedia?: boolean
}) {
  const tokens = tokenizeJson(value)

  return (
    <pre className="inspector-source-json" aria-label={ariaLabel}>
      {tokens.map((token, index): ReactNode => {
        const unquoted = token.kind === 'string'
          ? unquotedStringToken(token.value)
          : null
        const asset = unquoted
          ? artifactAssets?.get(unquoted)
            ?? (remoteMedia ? remoteMediaAsset(unquoted) : undefined)
          : undefined
        return (
          <span className={`json-${token.kind}`} key={`${index}-${token.value}`}>
            {token.value}
            {asset && (mediaDisplay === 'preview'
              ? <JsonMediaPreview asset={asset} />
              : <ArtifactThumb asset={asset} />)}
          </span>
        )
      })}
    </pre>
  )
}

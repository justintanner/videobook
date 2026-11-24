import { useState, type DragEvent } from 'react'
import { Check, Link2, Plus, RotateCcw } from 'lucide-react'
import type { PostView } from '../../../server/src/posts/post-contract'
import type { PostSourcePreview } from '@/videobook/notebook-canvas'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import { activeCellRefDrag, isCellRefDragEvent } from '@/videobook/cell-ref-drag'
import {
  postDeliveryBadges,
  postPlatformName,
  postTileMetrics,
  postTileNextStep,
  postTilePostedOn,
} from '@/videobook/post-delivery-review'
import './Posts.css'

export function PostTile({
  post,
  source,
  onSourceDrop,
  onRetry,
}: {
  post: PostView | undefined
  source: PostSourcePreview | undefined
  onSourceDrop?: (sourceCellId: string) => void
  onRetry?: () => void
}) {
  const sourced = post?.definition.source ? post : null
  return (
    <div className="post-tile">
      {sourced
        ? <PostTileClip post={sourced} source={source} />
        : <PostTileClipSlot onSourceDrop={onSourceDrop} />}
      <div className="post-tile-body">
        {sourced ? (
          <>
            <PostTileCaption caption={sourced.definition.caption} />
            <PostTileStatusLine post={sourced} onRetry={onRetry} />
          </>
        ) : <PostTileSourceHint />}
      </div>
    </div>
  )
}

function PostTileClip({ post, source }: { post: PostView; source: PostSourcePreview | undefined }) {
  const asset = source?.asset
  const isVideo = asset?.type === 'video'
  const posterUrl = asset?.thumbnailUrl ?? (isVideo ? null : asset?.mediaUrl ?? null)
  const videoUrl = posterUrl || !isVideo ? null : asset?.mediaUrl ?? null
  const duration = asset?.duration ?? null
  const delivered = postDeliveryBadges(post)
  return (
    <div className="post-tile-media">
      {posterUrl && (
        <span
          className="post-tile-backdrop"
          aria-hidden="true"
          style={{ backgroundImage: `url(${JSON.stringify(posterUrl)})` }}
        />
      )}
      {posterUrl && <img src={posterUrl} alt="" draggable={false} />}
      {videoUrl && <video src={`${videoUrl}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />}
      {delivered.length > 0 && (
        <span className="post-tile-overlay post-tile-overlay-top">
          {delivered.map(badge => (
            <span key={badge} className="post-badge"><Check size={10} strokeWidth={2.6} aria-hidden="true" />{badge}</span>
          ))}
        </span>
      )}
      {duration != null && duration > 0 && <span className="post-tile-overlay post-tile-overlay-end">{formatMediaTime(duration)}</span>}
    </div>
  )
}

function leavesTarget(event: DragEvent<HTMLElement>): boolean {
  const next = event.relatedTarget
  return !(next instanceof Node && event.currentTarget.contains(next))
}

function PostTileClipSlot({ onSourceDrop }: { onSourceDrop?: (sourceCellId: string) => void }) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent<HTMLElement>) => Boolean(onSourceDrop) && isCellRefDragEvent(event)
  return (
    <div
      className={`post-tile-media post-tile-slot${over ? ' post-tile-slot-over' : ''}`}
      onDragEnter={(event) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(true)
      }}
      onDragOver={(event) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!accepts(event) || !leavesTarget(event)) return
        event.stopPropagation()
        setOver(false)
      }}
      onDrop={(event) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(false)
        const drag = activeCellRefDrag(event)
        if (drag) onSourceDrop?.(drag.sourceCellId)
      }}
    >
      <Plus size={18} aria-hidden="true" />
      <span>{over ? 'Drop' : 'Clip'}</span>
    </div>
  )
}

function PostTileSourceHint() {
  return (
    <>
      <span className="post-tile-caption">Choose a clip to post</span>
      <span className="post-tile-hint">Or drop a cell's address on the clip slot.</span>
    </>
  )
}

function PostTileCaption({ caption }: { caption: string }) {
  const text = caption.trim()
  if (!text) return <span className="post-tile-caption post-tile-caption-empty">No caption yet</span>
  return <span className="post-tile-caption" title={text}>{text}</span>
}

function platformPhrase(post: PostView): string {
  return post.definition.platform === 'other' ? 'the platform' : postPlatformName(post)
}

function PostTileStatusLine({ post, onRetry }: { post: PostView; onRetry?: () => void }) {
  const status = post.runtime.status
  if (status === 'posting' || status === 'uploading') {
    return <PostTileProgress label={`${status === 'posting' ? 'Posting' : 'Uploading'} to ${platformPhrase(post)}`} />
  }
  if (status === 'failed') {
    return (
      <PostTileFailure
        message={post.runtime.error?.trim() || `${postPlatformName(post)} did not take the post`}
        onRetry={onRetry}
      />
    )
  }
  const nextStep = postTileNextStep(post)
  if (nextStep) return <PostTileNextStep post={post} text={nextStep} />
  const postedOn = postTilePostedOn(post)
  const posted = postedOn ? `Posted ${postedOn}` : 'Posted'
  const metrics = postTileMetrics(post)
  if (metrics.length > 0) {
    return (
      <span className="post-tile-results">
        <span className="post-tile-stats">
          {metrics.map(metric => <span key={metric.label}><strong>{metric.value}</strong> {metric.label}</span>)}
        </span>
        <span className="post-tile-hint">{posted}</span>
      </span>
    )
  }
  return (
    <span className="post-tile-results">
      <span className="post-tile-hint">{posted}</span>
      <span className="post-tile-hint post-tile-hint-action"><Plus size={11} aria-hidden="true" />Add results</span>
    </span>
  )
}

function PostTileFailure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <span className="post-tile-failure">
      <span className="post-tile-error">{message}</span>
      {onRetry && (
        <button
          type="button"
          className="post-tile-retry nodrag"
          title="Review the post again before it goes out"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onRetry()
          }}
        >
          <RotateCcw size={10} aria-hidden="true" />
          Retry
        </button>
      )}
    </span>
  )
}

function PostTileProgress({ label }: { label: string }) {
  return (
    <span className="post-tile-progress" role="status">
      <span className="post-tile-progress-bar" aria-hidden="true"><span /></span>
      <span>{label}</span>
    </span>
  )
}

function PostTileNextStep({ post, text }: { post: PostView; text: string }) {
  const needsLink = postDeliveryBadges(post).length > 0
  return (
    <span className={`post-tile-hint post-tile-next${needsLink ? ' post-tile-hint-attention' : ''}`}>
      <Link2 size={11} aria-hidden="true" />
      {text}
    </span>
  )
}

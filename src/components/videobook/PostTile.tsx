import { Check, Link2 } from 'lucide-react'
import type { PostView } from '../../../server/src/posts/post-contract'
import type { PostSourcePreview } from '@/videobook/notebook-canvas'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  postDeliveryBadges,
  postTileMetrics,
  postTileNextStep,
  postTilePostedOn,
} from '@/videobook/post-delivery-review'
import './Posts.css'

export function PostTile({ post, source }: { post: PostView | undefined; source: PostSourcePreview | undefined }) {
  return (
    <div className="post-tile">
      <PostTileMedia post={post} source={source} />
      <div className="post-tile-body">
        <PostTileCaption caption={post?.definition.caption ?? ''} />
        {post ? <PostTileStatusLine post={post} /> : <span className="post-tile-hint">Choose a clip to post</span>}
      </div>
    </div>
  )
}

function PostTileMedia({ post, source }: { post: PostView | undefined; source: PostSourcePreview | undefined }) {
  const asset = source?.asset
  const isVideo = asset?.type === 'video'
  const posterUrl = asset?.thumbnailUrl ?? (isVideo ? null : asset?.mediaUrl ?? null)
  const videoUrl = posterUrl || !isVideo ? null : asset?.mediaUrl ?? null
  const duration = asset?.duration ?? null
  const delivered = post ? postDeliveryBadges(post) : []
  return (
    <div className="post-tile-media">
      {posterUrl && <img src={posterUrl} alt="" draggable={false} />}
      {videoUrl && <video src={`${videoUrl}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />}
      {delivered.length > 0 && (
        <span className="post-tile-overlay post-tile-overlay-top">
          {delivered.map(badge => (
            <span key={badge} className="post-badge"><Check size={10} strokeWidth={2.6} aria-hidden="true" />{badge}</span>
          ))}
        </span>
      )}
      {source?.address && <span className="post-tile-overlay post-tile-overlay-start">from {source.address}</span>}
      {duration != null && duration > 0 && <span className="post-tile-overlay post-tile-overlay-end">{formatMediaTime(duration)}</span>}
    </div>
  )
}

function PostTileCaption({ caption }: { caption: string }) {
  const text = caption.trim()
  if (!text) return <span className="post-tile-caption post-tile-caption-empty">No caption yet</span>
  return <span className="post-tile-caption" title={text}>{text}</span>
}

function PostTileStatusLine({ post }: { post: PostView }) {
  const nextStep = postTileNextStep(post)
  if (nextStep) return <PostTileNextStep post={post} text={nextStep} />
  const metrics = postTileMetrics(post)
  if (metrics.length > 0) {
    return (
      <span className="post-tile-stats">
        {metrics.map(metric => <span key={metric.label}><strong>{metric.value}</strong> {metric.label}</span>)}
      </span>
    )
  }
  return (
    <span className="post-tile-stats">
      <span>{postTilePostedOn(post) ?? 'Posted'}</span>
      <span className="post-tile-hint post-tile-hint-action">Add results</span>
    </span>
  )
}

function PostTileNextStep({ post, text }: { post: PostView; text: string }) {
  const needsLink = postDeliveryBadges(post).length > 0
  return (
    <span className={`post-tile-hint${needsLink ? ' post-tile-hint-action' : ''}`}>
      {needsLink && <Link2 size={11} aria-hidden="true" />}
      {text}
    </span>
  )
}

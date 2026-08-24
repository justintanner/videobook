import { Film } from 'lucide-react'

type PostToXPreviewAsset = {
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
}

export function PostToXChatPreview({
  asset,
  postText,
  sourceLabel,
}: {
  asset: PostToXPreviewAsset | null
  postText: string
  sourceLabel: string
}) {
  const video = asset?.type === 'video' || asset?.type === 'final'
  const imageUrl = asset?.type === 'image'
    ? asset.mediaUrl ?? asset.thumbnailUrl
    : null

  return (
    <article className="x-post-chat-preview" aria-label="X post preview">
      <header>
        <span aria-hidden>X</span>
        <div>
          <strong>Post preview</strong>
          <small>{sourceLabel}</small>
        </div>
      </header>
      <div className="x-post-chat-preview-media">
        {video && asset?.mediaUrl ? (
          <video
            src={asset.mediaUrl}
            poster={asset.thumbnailUrl ?? undefined}
            controls
            playsInline
            preload="metadata"
          />
        ) : imageUrl ? (
          <img src={imageUrl} alt={`${sourceLabel} post preview`} />
        ) : (
          <div className="x-post-chat-preview-fallback">
            <Film size={28} aria-hidden />
            <span>Media preview unavailable</span>
          </div>
        )}
      </div>
      <div className="x-post-chat-preview-copy">
        <span>Message</span>
        <p className={postText ? undefined : 'x-post-chat-preview-empty'}>
          {postText || 'No message — media only'}
        </p>
        <small>{postText.length}/280 characters</small>
      </div>
    </article>
  )
}

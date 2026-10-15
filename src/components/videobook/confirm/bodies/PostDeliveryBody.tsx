import { Check, Film, TriangleAlert } from 'lucide-react'
import type { PostView } from '../../../../../server/src/posts/post-contract'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  deliveryCaptionLocked,
  dropboxFolderError,
  icloudProgressLabel,
  icloudShareHint,
  POST_CAPTION_LIMIT,
  type DeliveryDestination,
  type PostDeliveryReview,
} from '@/videobook/post-delivery-review'
import { icloudFolderError } from '../../../../../server/src/posts/post-folder'
import './PostDeliveryBody.css'

type PostDeliveryBodyProps = {
  post: PostView
  asset: AssetRecord | null
  review: PostDeliveryReview
  busy: boolean
  onCaptionChange: (caption: string) => void
  onFolderChange: (folder: string) => void
  onDestination: (destination: DeliveryDestination) => void
  onConnect: () => void
  onCheckConnection: () => void
  onOpenPost: () => void
}

function mediaFacts(asset: AssetRecord | null): string {
  if (!asset) return 'Media details unavailable'
  const facts = [
    asset.duration ? formatMediaTime(asset.duration) : null,
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
  ].filter(Boolean)
  return facts.length ? facts.join(' · ') : asset.type
}

function PostPreview({ post, asset, onOpenPost }: Pick<PostDeliveryBodyProps, 'post' | 'asset' | 'onOpenPost'>) {
  const frozen = Boolean(post.definition.source?.snapshotArtifactId)
  const media = asset?.mediaUrl && asset.type === 'image'
    ? <img src={asset.mediaUrl} alt="" />
    : asset?.mediaUrl
      ? <video src={asset.mediaUrl} poster={asset.thumbnailUrl ?? undefined} muted playsInline preload="metadata" aria-label={`${post.address} clip`} />
      : <span className="post-delivery-media-fallback"><Film size={18} aria-hidden="true" /></span>
  return (
    <article className={`post-delivery-post${frozen ? '' : ' post-delivery-post-blocked'}`} aria-label={`Post ${post.address}`}>
      <div className="post-delivery-media">{media}</div>
      <div className="post-delivery-post-copy">
        <strong>{post.address} · {asset?.label ?? post.label}</strong>
        <span>{mediaFacts(asset)}</span>
        {frozen
          ? <span>Clip saved {new Date(post.definition.createdAt).toLocaleString()}</span>
          : <span className="post-delivery-warning"><TriangleAlert size={12} aria-hidden="true" />No saved source clip</span>}
        {post.runtime.icloud?.completedAt && <span className="post-delivery-done"><Check size={12} aria-hidden="true" />Already on iPhone; saving again checks the files</span>}
        {post.runtime.dropbox?.completedAt && <span className="post-delivery-done"><Check size={12} aria-hidden="true" />Already in Dropbox; uploading again checks the files</span>}
        {!frozen && <button type="button" onClick={onOpenPost}>Choose a clip in the Post panel</button>}
      </div>
    </article>
  )
}

function CaptionField({ post, review, busy, onCaptionChange }: Pick<PostDeliveryBodyProps, 'post' | 'review' | 'busy' | 'onCaptionChange'>) {
  const locked = deliveryCaptionLocked(post)
  const tooLong = review.caption.length > POST_CAPTION_LIMIT
  return (
    <div className="post-delivery-caption">
      <div className="post-delivery-label-row">
        <label htmlFor="post-delivery-caption">Caption</label>
        <small className={tooLong ? 'confirm-field-error' : undefined}>{review.caption.length.toLocaleString()} / {POST_CAPTION_LIMIT.toLocaleString()}</small>
      </div>
      <textarea
        id="post-delivery-caption"
        value={review.caption}
        disabled={busy}
        readOnly={locked}
        placeholder="Write the caption that ships with this clip…"
        onChange={event => onCaptionChange(event.target.value)}
      />
      <small>{locked
        ? 'Frozen at the first delivery. Create a new Post to change it.'
        : `Saved to ${post.address} and written to caption.txt${post.definition.credits ? ' with its credits' : ''}.`}</small>
    </div>
  )
}

function DropboxAccount({ review, busy, onConnect, onCheckConnection }: Pick<PostDeliveryBodyProps, 'review' | 'busy' | 'onConnect' | 'onCheckConnection'>) {
  const connection = review.connection
  if (!connection) return <p className="post-delivery-account">Checking Dropbox…</p>
  if (connection.connected) {
    return <p className="post-delivery-account post-delivery-account-ready"><Check size={12} aria-hidden="true" />Dropbox connected</p>
  }
  return (
    <div className="post-delivery-account post-delivery-account-missing">
      <span>{review.connecting || connection.pending ? 'Waiting for Dropbox approval…' : 'Dropbox not connected'}</span>
      <div>
        <button type="button" disabled={busy || review.connecting || !connection.hasCredentials} onClick={onConnect}>Connect Dropbox ↗</button>
        <button type="button" disabled={busy} onClick={onCheckConnection}>Check again</button>
      </div>
      {connection.error && <small className="confirm-field-error">{connection.error}</small>}
    </div>
  )
}

function icloudFolderLabel(folder: string): string {
  const trimmed = folder.trim().replace(/\/+$/u, '')
  return trimmed || '…'
}

export function PostDeliveryBody(props: PostDeliveryBodyProps) {
  const icloud = props.review.destination === 'icloud'
  const folder = icloud ? props.review.icloudFolder : props.review.dropboxFolder
  const folderError = icloud ? icloudFolderError(props.review.icloudFolder) : dropboxFolderError(props.review.dropboxFolder)
  const share = icloudShareHint(props.review.icloud)
  const progress = props.review.receipt && icloud ? icloudProgressLabel(props.review.sync?.phase ?? null, props.review.sync?.error) : null
  const unavailable = props.review.icloud && !props.review.icloud.available ? (props.review.icloud.reason ?? "iCloud Drive isn't available on this Mac.") : null
  return (
    <div className="post-delivery-body">
      <PostPreview post={props.post} asset={props.asset} onOpenPost={props.onOpenPost} />
      <CaptionField post={props.post} review={props.review} busy={props.busy} onCaptionChange={props.onCaptionChange} />
      <div className="post-delivery-destination">
        <span className="post-delivery-heading">Destination</span>
        <div className="post-delivery-switch" role="group" aria-label="Destination">
          <button type="button" aria-pressed={icloud} disabled={props.busy} onClick={() => props.onDestination('icloud')}>iCloud · iPhone</button>
          <button type="button" aria-pressed={!icloud} disabled={props.busy} onClick={() => props.onDestination('dropbox')}>Dropbox</button>
        </div>
        {unavailable && <p className="post-delivery-warning"><TriangleAlert size={12} aria-hidden="true" />{unavailable}</p>}
        {icloud ? (
          <>
            {share && <p className={props.review.icloud?.shared === false ? 'post-delivery-warning' : 'post-delivery-done'}>{share}</p>}
            <label className="confirm-field" htmlFor="post-delivery-folder">Folder</label>
            <input
              id="post-delivery-folder"
              type="text"
              value={folder}
              disabled={props.busy}
              spellCheck={false}
              aria-invalid={folderError ? true : undefined}
              onChange={event => props.onFolderChange(event.target.value)}
            />
            <small>Appears on iPhone in Files › Shared › Videobook › {icloudFolderLabel(folder)}</small>
          </>
        ) : (
          <>
            <DropboxAccount review={props.review} busy={props.busy} onConnect={props.onConnect} onCheckConnection={props.onCheckConnection} />
            <label className="confirm-field" htmlFor="post-delivery-folder">Folder</label>
            <input
              id="post-delivery-folder"
              type="text"
              value={folder}
              disabled={props.busy}
              spellCheck={false}
              aria-invalid={folderError ? true : undefined}
              onChange={event => props.onFolderChange(event.target.value)}
            />
            <small>Uploads clip and caption.txt here. Other files in the folder are kept.</small>
          </>
        )}
        {props.review.receipt && <p className="post-delivery-receipt">{props.review.receipt}</p>}
        {progress && <p className="post-delivery-progress">{progress}</p>}
      </div>
    </div>
  )
}

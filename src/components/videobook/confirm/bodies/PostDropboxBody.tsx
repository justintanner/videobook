import { Check, Film, TriangleAlert } from 'lucide-react'
import type { PostView } from '../../../../../server/src/posts/post-contract'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  dropboxCaptionLocked,
  dropboxFolderError,
  POST_CAPTION_LIMIT,
  type PostDropboxReview,
} from '@/videobook/post-dropbox-review'
import './PostDropboxBody.css'

type PostDropboxBodyProps = {
  post: PostView
  asset: AssetRecord | null
  review: PostDropboxReview
  busy: boolean
  onCaptionChange: (caption: string) => void
  onFolderChange: (folder: string) => void
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

function PostPreview({ post, asset, onOpenPost }: Pick<PostDropboxBodyProps, 'post' | 'asset' | 'onOpenPost'>) {
  const frozen = Boolean(post.definition.source?.snapshotArtifactId)
  const media = asset?.mediaUrl && asset.type === 'image'
    ? <img src={asset.mediaUrl} alt="" />
    : asset?.mediaUrl
      ? <video src={asset.mediaUrl} poster={asset.thumbnailUrl ?? undefined} muted playsInline preload="metadata" aria-label={`${post.address} clip`} />
      : <span className="post-dropbox-media-fallback"><Film size={18} aria-hidden="true" /></span>
  return (
    <article className={`post-dropbox-post${frozen ? '' : ' post-dropbox-post-blocked'}`} aria-label={`Post ${post.address}`}>
      <div className="post-dropbox-media">{media}</div>
      <div className="post-dropbox-post-copy">
        <strong>{post.address} · {asset?.label ?? post.label}</strong>
        <span>{mediaFacts(asset)}</span>
        {frozen
          ? <span>Clip saved {new Date(post.definition.createdAt).toLocaleString()}</span>
          : <span className="post-dropbox-warning"><TriangleAlert size={12} aria-hidden="true" />No saved source clip</span>}
        {post.runtime.dropbox?.completedAt && <span className="post-dropbox-done"><Check size={12} aria-hidden="true" />Already in Dropbox; uploading again checks the files</span>}
        {!frozen && <button type="button" onClick={onOpenPost}>Choose a clip in the Post panel</button>}
      </div>
    </article>
  )
}

function CaptionField({ post, review, busy, onCaptionChange }: Pick<PostDropboxBodyProps, 'post' | 'review' | 'busy' | 'onCaptionChange'>) {
  const locked = dropboxCaptionLocked(post)
  const tooLong = review.caption.length > POST_CAPTION_LIMIT
  return (
    <div className="post-dropbox-caption">
      <div className="post-dropbox-label-row">
        <label htmlFor="post-dropbox-caption">Caption</label>
        <small className={tooLong ? 'confirm-field-error' : undefined}>{review.caption.length.toLocaleString()} / {POST_CAPTION_LIMIT.toLocaleString()}</small>
      </div>
      <textarea
        id="post-dropbox-caption"
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

function DropboxAccount({ review, busy, onConnect, onCheckConnection }: Pick<PostDropboxBodyProps, 'review' | 'busy' | 'onConnect' | 'onCheckConnection'>) {
  const connection = review.connection
  if (!connection) return <p className="post-dropbox-account">Checking Dropbox…</p>
  if (connection.connected) {
    return <p className="post-dropbox-account post-dropbox-account-ready"><Check size={12} aria-hidden="true" />Dropbox connected</p>
  }
  return (
    <div className="post-dropbox-account post-dropbox-account-missing">
      <span>{review.connecting || connection.pending ? 'Waiting for Dropbox approval…' : 'Dropbox not connected'}</span>
      <div>
        <button type="button" disabled={busy || review.connecting || !connection.hasCredentials} onClick={onConnect}>Connect Dropbox ↗</button>
        <button type="button" disabled={busy} onClick={onCheckConnection}>Check again</button>
      </div>
      {connection.error && <small className="confirm-field-error">{connection.error}</small>}
    </div>
  )
}

export function PostDropboxBody(props: PostDropboxBodyProps) {
  const folderError = dropboxFolderError(props.review.folder)
  return (
    <div className="post-dropbox-body">
      <PostPreview post={props.post} asset={props.asset} onOpenPost={props.onOpenPost} />
      <CaptionField post={props.post} review={props.review} busy={props.busy} onCaptionChange={props.onCaptionChange} />
      <div className="post-dropbox-destination">
        <span className="post-dropbox-heading">Account</span>
        <DropboxAccount review={props.review} busy={props.busy} onConnect={props.onConnect} onCheckConnection={props.onCheckConnection} />
        <label className="confirm-field" htmlFor="post-dropbox-folder">Folder</label>
        <input
          id="post-dropbox-folder"
          type="text"
          value={props.review.folder}
          disabled={props.busy}
          spellCheck={false}
          aria-invalid={folderError ? true : undefined}
          onChange={event => props.onFolderChange(event.target.value)}
        />
        <small>Uploads clip and caption.txt here. Other files in the folder are kept.</small>
      </div>
    </div>
  )
}

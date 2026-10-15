import { useState, type KeyboardEvent } from 'react'
import { Check, ChevronLeft, ChevronRight, Film, Sparkles, TriangleAlert, X } from 'lucide-react'
import type { PostView } from '../../../../../server/src/posts/post-contract'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  deliveryCaptionLocked,
  dropboxFolderError,
  icloudProgressLabel,
  icloudShareHint,
  POST_CAPTION_LIMIT,
  postAwaitingLink,
  type DeliveryDestination,
  type PostDeliveryReview,
} from '@/videobook/post-delivery-review'
import { icloudFolderError } from '../../../../../server/src/posts/post-folder'
import {
  PLATFORM_NAMES,
  POST_COPY_LANGUAGE_NAMES,
  POST_COPY_LANGUAGES,
  type PostCopyLanguage,
} from '../../../../../server/src/posts/post-copy-format'
import {
  addCopyTag,
  COPY_PLATFORMS,
  COPY_PROMPT_PRESETS,
  copyLimitStatus,
  copyProvenance,
  currentCopyVersion,
  editCopyVersion,
  removeCopyTag,
  stepCopyVersion,
  type PostCopyState,
} from '@/videobook/post-copy-review'
import { PostLinkField, type PostLinkArgs } from '../../PostLinkField'
import './PostDeliveryBody.css'

const LANGUAGE_LABELS: Readonly<Record<PostCopyLanguage, string>> = { en: 'EN', th: 'TH · ไทย' }

type PostDeliveryBodyProps = {
  post: PostView
  asset: AssetRecord | null
  review: PostDeliveryReview
  busy: boolean
  onCopyChange: (copy: PostCopyState) => void
  onLanguage: (language: PostCopyLanguage) => void
  onRegen: () => void
  onFolderChange: (folder: string) => void
  onDestination: (destination: DeliveryDestination) => void
  onConnect: () => void
  onCheckConnection: () => void
  onOpenPost: () => void
  onLink: (args: PostLinkArgs) => Promise<unknown>
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

function CopyToolbar({ review, disabled, onCopyChange, onLanguage }: Pick<PostDeliveryBodyProps, 'review' | 'onCopyChange' | 'onLanguage'> & { disabled: boolean }) {
  const copy = review.copy
  return (
    <div className="post-copy-toolbar">
      <div className="post-copy-group">
        <span className="post-delivery-heading">Platform</span>
        <div className="post-delivery-switch" role="group" aria-label="Platform">
          {COPY_PLATFORMS.map(item => (
            <button key={item.id} type="button" aria-pressed={copy.platform === item.id} disabled={disabled} onClick={() => onCopyChange({ ...copy, platform: item.id })}>{item.label}</button>
          ))}
        </div>
      </div>
      <div className="post-copy-group">
        <span className="post-delivery-heading">Language</span>
        <div className="post-delivery-switch" role="group" aria-label="Caption language">
          {POST_COPY_LANGUAGES.map(language => (
            <button key={language} type="button" aria-pressed={copy.language === language} disabled={disabled} onClick={() => onLanguage(language)}>{LANGUAGE_LABELS[language]}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

function VersionStepper({ copy, disabled, onCopyChange }: { copy: PostCopyState; disabled: boolean; onCopyChange: (copy: PostCopyState) => void }) {
  const track = copy.tracks[copy.language]
  if (!track || track.versions.length < 2) return null
  return (
    <span className="post-copy-versions">
      <button type="button" aria-label="Previous caption version" disabled={disabled || track.index === 0} onClick={() => onCopyChange(stepCopyVersion(copy, -1))}><ChevronLeft size={12} aria-hidden="true" /></button>
      <small>v{track.index + 1}/{track.versions.length}</small>
      <button type="button" aria-label="Next caption version" disabled={disabled || track.index === track.versions.length - 1} onClick={() => onCopyChange(stepCopyVersion(copy, 1))}><ChevronRight size={12} aria-hidden="true" /></button>
    </span>
  )
}

function TagEditor({ copy, disabled, onCopyChange }: { copy: PostCopyState; disabled: boolean; onCopyChange: (copy: PostCopyState) => void }) {
  const [draft, setDraft] = useState('')
  const tags = currentCopyVersion(copy)?.tags ?? []
  const commit = () => {
    if (!draft.trim()) return
    onCopyChange(addCopyTag(copy, draft))
    setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Backspace' && !draft && tags.length) {
      onCopyChange(removeCopyTag(copy, tags[tags.length - 1]))
    }
  }
  return (
    <div className="post-copy-tags">
      <div className="post-delivery-label-row">
        <label htmlFor="post-delivery-tag">Tags</label>
        <small>{tags.length} · added after the caption</small>
      </div>
      <div className="post-copy-tag-field" lang={copy.language}>
        {tags.map(tag => (
          <span key={tag} className="post-copy-tag">
            #{tag}
            <button type="button" aria-label={`Remove tag ${tag}`} disabled={disabled} onClick={() => onCopyChange(removeCopyTag(copy, tag))}><X size={11} aria-hidden="true" /></button>
          </span>
        ))}
        <input
          id="post-delivery-tag"
          type="text"
          value={draft}
          disabled={disabled}
          spellCheck={false}
          placeholder={tags.length ? '+ tag' : 'Add a tag, then Enter'}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
    </div>
  )
}

function RegenPanel({ copy, disabled, onCopyChange, onRegen }: { copy: PostCopyState; disabled: boolean; onCopyChange: (copy: PostCopyState) => void; onRegen: () => void }) {
  const addPreset = (preset: string) => onCopyChange({ ...copy, prompt: copy.prompt.trim() ? `${copy.prompt.trim()}, ${preset.toLowerCase()}` : preset })
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return
    event.preventDefault()
    if (!disabled) onRegen()
  }
  return (
    <div className="post-copy-regen">
      <div className="post-delivery-label-row">
        <label htmlFor="post-delivery-astra">Regen with Astra</label>
        <small>video analysis + your note · {PLATFORM_NAMES[copy.platform]} · {POST_COPY_LANGUAGE_NAMES[copy.language]}</small>
      </div>
      <div className="post-copy-regen-row">
        <input
          id="post-delivery-astra"
          type="text"
          value={copy.prompt}
          disabled={disabled}
          maxLength={1000}
          placeholder="Tell Astra how to rewrite — punchier hook, mention the rain, 3 tags…"
          onChange={event => onCopyChange({ ...copy, prompt: event.target.value })}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="post-copy-regen-button" disabled={disabled} onClick={onRegen}>
          <Sparkles size={12} aria-hidden="true" />Regen post
        </button>
      </div>
      <div className="post-copy-presets">
        {COPY_PROMPT_PRESETS.map(preset => (
          <button key={preset} type="button" disabled={disabled} onClick={() => addPreset(preset)}>{preset}</button>
        ))}
      </div>
    </div>
  )
}

function CaptionField({ post, review, busy, onCopyChange, onLanguage, onRegen }: Pick<PostDeliveryBodyProps, 'post' | 'review' | 'busy' | 'onCopyChange' | 'onLanguage' | 'onRegen'>) {
  const locked = deliveryCaptionLocked(post)
  const copy = review.copy
  const drafting = copy.drafting?.language === copy.language
  const disabled = busy || locked
  const status = copyLimitStatus(copy)
  const version = currentCopyVersion(copy)
  const auto = version && version.origin !== 'saved' && version.origin !== 'edited'
  return (
    <div className="post-delivery-caption">
      <CopyToolbar review={review} disabled={disabled || Boolean(copy.drafting)} onCopyChange={onCopyChange} onLanguage={onLanguage} />
      <div className="post-delivery-label-row">
        <span className="post-copy-caption-label">
          <label htmlFor="post-delivery-caption">Caption</label>
          {auto && <span className="post-copy-badge"><Sparkles size={10} aria-hidden="true" />Auto · from video analysis</span>}
        </span>
        <span className="post-copy-caption-meta">
          <VersionStepper copy={copy} disabled={disabled || Boolean(copy.drafting)} onCopyChange={onCopyChange} />
          <small className={status.over || status.length > POST_CAPTION_LIMIT ? 'confirm-field-error' : undefined}>{status.length.toLocaleString()} / {status.limit.toLocaleString()}</small>
        </span>
      </div>
      {drafting
        ? <div className="post-copy-drafting" role="status">Astra is writing the {POST_COPY_LANGUAGE_NAMES[copy.language]} caption for {PLATFORM_NAMES[copy.platform]}…</div>
        : (
          <textarea
            id="post-delivery-caption"
            lang={copy.language}
            value={locked ? post.definition.caption : version?.body ?? ''}
            disabled={busy}
            readOnly={locked}
            placeholder="Write the caption that ships with this clip…"
            onChange={event => onCopyChange(editCopyVersion(copy, { body: event.target.value }))}
          />
        )}
      {copy.error && <small className="confirm-field-error">{copy.error}</small>}
      {!locked && <TagEditor copy={copy} disabled={disabled || drafting} onCopyChange={onCopyChange} />}
      <small>{locked
        ? 'Frozen at the first delivery. Create a new Post to change it.'
        : `${copyProvenance(copy)} · Saved to ${post.address} and written to caption.txt${post.definition.credits ? ' with its credits' : ''}.`}</small>
      {!locked && <RegenPanel copy={copy} disabled={busy || Boolean(copy.drafting)} onCopyChange={onCopyChange} onRegen={onRegen} />}
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
      <CaptionField post={props.post} review={props.review} busy={props.busy} onCopyChange={props.onCopyChange} onLanguage={props.onLanguage} onRegen={props.onRegen} />
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
        {postAwaitingLink(props.post) && <PostLinkField post={props.post} disabled={props.busy} className="post-delivery-link" onLink={props.onLink} />}
      </div>
    </div>
  )
}

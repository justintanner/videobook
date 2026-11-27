import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Cloud, Copy, Download, Film, Lock, Pause, Play, Sparkles, TriangleAlert, X } from 'lucide-react'
import type { PostView } from '../../../../../server/src/posts/post-contract'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { formatMediaTime } from '@/videobook/notebook-cell-presentation'
import {
  deliveryCaptionLocked,
  deliveryStatusView,
  icloudShareHint,
  postAwaitingLink,
  postLinkPrompt,
  POST_CAPTION_LIMIT,
  type DeliveryDestination,
  type PostDeliveryReview,
} from '@/videobook/post-delivery-review'
import type { PostDownload } from '../../../../../server/src/posts/post-folder'
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
  copyCaption,
  copyLimitStatus,
  copyProvenance,
  currentCopyVersion,
  editCopyVersion,
  removeCopyTag,
  stepCopyVersion,
  type PostCopyState,
} from '@/videobook/post-copy-review'
import { PostLinkField, type PostLinkArgs } from '../../PostLinkField'
import { DeliveryStatus } from './DeliveryStatus'
import './PostDeliveryBody.css'

const LANGUAGE_LABELS: Readonly<Record<PostCopyLanguage, string>> = { en: 'EN', th: 'TH · ไทย' }
const COPIED_FOR_MS = 1600

type PostDeliveryBodyProps = {
  post: PostView
  asset: AssetRecord | null
  review: PostDeliveryReview
  busy: boolean
  downloadingClip: boolean
  downloadBlocked: string | null
  onCopyChange: (copy: PostCopyState) => void
  onLanguage: (language: PostCopyLanguage) => void
  onRegen: () => void
  onFolderChange: (folder: string) => void
  onDestination: (destination: DeliveryDestination) => void
  onPostToX: () => void
  onCopyCaption: (caption: string) => Promise<boolean>
  onDownloadClip: () => void
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

function HudPanel({ kicker, meta, label, tone = 'default', className, children }: {
  kicker: ReactNode
  meta?: ReactNode
  label: string
  tone?: 'default' | 'next'
  className: string
  children: ReactNode
}) {
  return (
    <section className={`post-hud-panel post-hud-${tone} ${className}`} aria-label={label}>
      <header className="post-hud-head">
        <span className="post-hud-kicker">{kicker}</span>
        {meta && <span className="post-hud-meta">{meta}</span>}
      </header>
      <div className="post-hud-body">{children}</div>
    </section>
  )
}

function ClipMedia({ post, asset }: Pick<PostDeliveryBodyProps, 'post' | 'asset'>) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const toggle = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => setPlaying(false))
    else video.pause()
  }
  if (!asset?.mediaUrl) return <span className="post-delivery-media-fallback"><Film size={22} aria-hidden="true" /></span>
  if (asset.type === 'image') return <img src={asset.mediaUrl} alt="" />
  return (
    <>
      <video
        ref={videoRef}
        src={asset.mediaUrl}
        poster={asset.thumbnailUrl ?? undefined}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={`${post.address} clip`}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <button type="button" className={`post-clip-play${playing ? ' post-clip-playing' : ''}`} aria-label={`${playing ? 'Pause' : 'Play'} the ${post.address} clip`} onClick={toggle}>
        {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
    </>
  )
}

function ClipPanel({ post, asset, busy, downloadingClip, downloadBlocked, onDownloadClip, onOpenPost }: Pick<PostDeliveryBodyProps, 'post' | 'asset' | 'busy' | 'downloadingClip' | 'downloadBlocked' | 'onDownloadClip' | 'onOpenPost'>) {
  const frozen = Boolean(post.definition.source?.snapshotArtifactId)
  return (
    <HudPanel kicker="01 · Clip" meta={post.address} label={`Clip ${post.address}`} className={`post-delivery-clip${frozen ? '' : ' post-delivery-clip-blocked'}`}>
      <div className="post-clip-preview">
        <ClipMedia post={post} asset={asset} />
        <div className="post-clip-plate">
          <strong>{asset?.label ?? post.label}</strong>
          <span>{mediaFacts(asset)}</span>
        </div>
      </div>
      <div className="post-clip-side">
        <dl className="post-clip-facts">
          <dt>Saved</dt>
          {frozen
            ? <dd>{new Date(post.definition.createdAt).toLocaleString()}</dd>
            : <dd className="post-delivery-warning"><TriangleAlert size={12} aria-hidden="true" />No saved source clip</dd>}
        </dl>
        {post.runtime.download?.completedAt && <p className="post-delivery-done"><Check size={12} aria-hidden="true" />Downloaded before; downloading again gives the same files</p>}
        {!frozen && <button type="button" className="post-delivery-secondary" onClick={onOpenPost}>Choose a clip in the Post panel</button>}
        <button
          type="button"
          className="post-delivery-action"
          disabled={busy || Boolean(downloadBlocked)}
          title={downloadBlocked ?? 'Download the clip and caption.txt'}
          onClick={onDownloadClip}
        >
          <Download size={15} aria-hidden="true" />
          {downloadingClip ? 'Preparing…' : 'Download clip'}
        </button>
      </div>
    </HudPanel>
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

function LengthMeter({ length, limit, over }: { length: number; limit: number; over: boolean }) {
  const fill = { '--post-meter-fill': `${Math.max(4, Math.min(100, (length / Math.max(1, limit)) * 100))}%` } as CSSProperties
  return (
    <span className={`post-copy-length${over ? ' confirm-field-error' : ''}`}>
      <small>{length.toLocaleString()} / {limit.toLocaleString()}</small>
      <span className="post-copy-meter" style={fill} aria-hidden="true"><span /></span>
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
      <div className="post-copy-regen-row">
        <label htmlFor="post-delivery-astra"><Sparkles size={11} aria-hidden="true" />Regen with Astra</label>
        <input
          id="post-delivery-astra"
          type="text"
          value={copy.prompt}
          disabled={disabled}
          maxLength={1000}
          placeholder="Tell Astra how to rewrite — punchier hook, mention the rain, 3 tags…"
          aria-describedby="post-delivery-astra-context"
          onChange={event => onCopyChange({ ...copy, prompt: event.target.value })}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="post-copy-regen-button" disabled={disabled} onClick={onRegen}>
          <Sparkles size={12} aria-hidden="true" />Regen post
        </button>
      </div>
      <div className="post-copy-presets">
        {COPY_PROMPT_PRESETS.map(preset => (
          <button key={preset} type="button" disabled={disabled} onClick={() => addPreset(preset)}>+ {preset}</button>
        ))}
        <small id="post-delivery-astra-context">video analysis + your note · {PLATFORM_NAMES[copy.platform]} · {POST_COPY_LANGUAGE_NAMES[copy.language]}</small>
      </div>
    </div>
  )
}

function CopyCaptionButton({ caption, disabled, onCopyCaption }: { caption: string; disabled: boolean; onCopyCaption: (caption: string) => Promise<boolean> }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  const copy = async () => {
    if (!(await onCopyCaption(caption))) return
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_FOR_MS)
  }
  return (
    <button
      type="button"
      className={`post-delivery-action${copied ? ' post-delivery-action-done' : ''}`}
      disabled={disabled || !caption.trim()}
      onClick={() => void copy()}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy caption'}</span>
    </button>
  )
}

function CaptionPanel({ post, review, busy, onCopyChange, onLanguage, onRegen, onCopyCaption }: Pick<PostDeliveryBodyProps, 'post' | 'review' | 'busy' | 'onCopyChange' | 'onLanguage' | 'onRegen' | 'onCopyCaption'>) {
  const locked = deliveryCaptionLocked(post)
  const copy = review.copy
  const drafting = copy.drafting?.language === copy.language
  const disabled = busy || locked
  const status = copyLimitStatus(copy)
  const version = currentCopyVersion(copy)
  const auto = version && version.origin !== 'saved' && version.origin !== 'edited'
  const caption = locked ? post.definition.caption : copyCaption(copy)
  const target = `${PLATFORM_NAMES[locked ? post.definition.platform : copy.platform]} · ${POST_COPY_LANGUAGE_NAMES[copy.language]}`
  const meta = locked
    ? <>{target} · <span className="post-hud-locked"><Lock size={11} aria-hidden="true" />Locked</span></>
    : target
  return (
    <HudPanel kicker="02 · Copy" meta={meta} label="Post copy" className="post-delivery-caption">
      {!locked && <CopyToolbar review={review} disabled={disabled || Boolean(copy.drafting)} onCopyChange={onCopyChange} onLanguage={onLanguage} />}
      <div className="post-delivery-caption-field">
        <div className="post-delivery-label-row">
          <span className="post-copy-caption-label">
            <label htmlFor="post-delivery-caption">Caption</label>
            {auto && <span className="post-copy-badge"><Sparkles size={10} aria-hidden="true" />Auto · from video analysis</span>}
          </span>
          <span className="post-copy-caption-meta">
            <VersionStepper copy={copy} disabled={disabled || Boolean(copy.drafting)} onCopyChange={onCopyChange} />
            <LengthMeter length={status.length} limit={status.limit} over={status.over || status.length > POST_CAPTION_LIMIT} />
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
      </div>
      {!locked && <TagEditor copy={copy} disabled={disabled || drafting} onCopyChange={onCopyChange} />}
      <div className="post-copy-actions">
        <CopyCaptionButton caption={caption} disabled={busy || drafting} onCopyCaption={onCopyCaption} />
        <small>
          {locked && <Lock size={11} aria-hidden="true" />}
          {locked
            ? 'Frozen at the first delivery. Create a new Post to change it.'
            : `${copyProvenance(copy)} · Saved to ${post.address} and written to caption.txt${post.definition.credits ? ' with its credits' : ''}.`}
        </small>
      </div>
      {!locked && <RegenPanel copy={copy} disabled={busy || Boolean(copy.drafting)} onCopyChange={onCopyChange} onRegen={onRegen} />}
    </HudPanel>
  )
}

function LinkPanel({ post, review, busy, onLink }: Pick<PostDeliveryBodyProps, 'post' | 'review' | 'busy' | 'onLink'>) {
  const kicker = <><span className="post-hud-pulse" aria-hidden="true" />Next</>
  return (
    <HudPanel kicker={kicker} meta="04 · Link" label="Published link" tone="next" className="post-delivery-next">
      <PostLinkField post={post} disabled={busy || Boolean(review.copy.drafting)} className="post-delivery-link post-delivery-link-wide" onLink={onLink} />
    </HudPanel>
  )
}

function DownloadLinks({ download }: { download: PostDownload }) {
  return (
    <div className="post-delivery-downloads">
      <a href={download.clip_url} download={download.filename}><Download size={12} aria-hidden="true" />{download.filename}</a>
      <a href={download.caption_url} download><Download size={12} aria-hidden="true" />caption.txt</a>
    </div>
  )
}

function icloudFolderLabel(folder: string): string {
  const trimmed = folder.trim().replace(/\/+$/u, '')
  return trimmed || '…'
}

function IcloudDestination({ review, busy, onFolderChange }: Pick<PostDeliveryBodyProps, 'review' | 'busy' | 'onFolderChange'>) {
  const folder = review.icloudFolder
  const folderError = icloudFolderError(folder)
  const share = icloudShareHint(review.icloud)
  return (
    <>
      {share && <p className={review.icloud?.shared === false ? 'post-delivery-warning' : 'post-delivery-done'}>{review.icloud?.shared !== false && <Check size={12} aria-hidden="true" />}{share}</p>}
      <label className="confirm-field" htmlFor="post-delivery-folder">Folder</label>
      <input
        id="post-delivery-folder"
        type="text"
        value={folder}
        disabled={busy}
        spellCheck={false}
        aria-invalid={folderError ? true : undefined}
        onChange={event => onFolderChange(event.target.value)}
      />
      <small className="post-delivery-path">Appears on iPhone in Files › Shared › Videobook › {icloudFolderLabel(folder)}</small>
    </>
  )
}

function DeliverPanel(props: PostDeliveryBodyProps) {
  const icloud = props.review.destination === 'icloud'
  const status = icloud ? deliveryStatusView(props.review, props.busy, Boolean(props.post.runtime.icloud?.completedAt)) : null
  const unavailable = icloud && props.review.icloud && !props.review.icloud.available ? (props.review.icloud.reason ?? "iCloud Drive isn't available on this Mac.") : null
  const linkPending = !props.post.runtime.url && !postAwaitingLink(props.post)
  return (
    <HudPanel kicker="03 · Deliver" meta={icloud ? 'iCloud · shared folder' : 'This computer · Downloads'} label="Delivery" className="post-delivery-destination">
      <span className="post-delivery-heading">Destination</span>
      <div className="post-delivery-switch post-delivery-destinations" role="group" aria-label="Destination">
        <button type="button" aria-pressed={icloud} disabled={props.busy} onClick={() => props.onDestination('icloud')}><Cloud size={16} aria-hidden="true" />iCloud · iPhone</button>
        <button type="button" aria-pressed={!icloud} disabled={props.busy} onClick={() => props.onDestination('download')}><Download size={16} aria-hidden="true" />Download</button>
        <button type="button" aria-pressed={false} disabled={props.busy} onClick={props.onPostToX}><ArrowUpRight size={16} aria-hidden="true" />X</button>
      </div>
      {unavailable && <p className="post-delivery-warning"><TriangleAlert size={12} aria-hidden="true" />{unavailable}</p>}
      {icloud
        ? <IcloudDestination review={props.review} busy={props.busy} onFolderChange={props.onFolderChange} />
        : <small className="post-delivery-path">Downloads the clip and caption.txt to this computer for a manual upload.</small>}
      {status && <DeliveryStatus view={status} />}
      {!icloud && props.review.receipt && <p className="post-delivery-receipt">{props.review.receipt}</p>}
      {!icloud && props.review.download && <DownloadLinks download={props.review.download} />}
      {linkPending && (
        <details className="post-delivery-link-details">
          <summary><ChevronRight size={13} aria-hidden="true" className="post-delivery-caret" />{postLinkPrompt(props.post)}</summary>
          <PostLinkField post={props.post} disabled={props.busy || Boolean(props.review.copy.drafting)} className="post-delivery-link" onLink={props.onLink} />
        </details>
      )}
    </HudPanel>
  )
}

export function PostDeliveryBody(props: PostDeliveryBodyProps) {
  return (
    <div className="post-delivery-body">
      <ClipPanel
        post={props.post}
        asset={props.asset}
        busy={props.busy}
        downloadingClip={props.downloadingClip}
        downloadBlocked={props.downloadBlocked}
        onDownloadClip={props.onDownloadClip}
        onOpenPost={props.onOpenPost}
      />
      <div className="post-delivery-main">
        <CaptionPanel
          post={props.post}
          review={props.review}
          busy={props.busy}
          onCopyChange={props.onCopyChange}
          onLanguage={props.onLanguage}
          onRegen={props.onRegen}
          onCopyCaption={props.onCopyCaption}
        />
        {postAwaitingLink(props.post) && <LinkPanel post={props.post} review={props.review} busy={props.busy} onLink={props.onLink} />}
      </div>
      <DeliverPanel {...props} />
    </div>
  )
}

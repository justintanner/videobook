import { useState } from 'react'
import { Check, Download, Smartphone, Send } from 'lucide-react'
import { POST_PLATFORMS } from '../../../server/src/posts/post-contract'
import type { PostPlatform, PostView } from '../../../server/src/posts/post-contract'
import { PLATFORM_NAMES } from '../../../server/src/posts/post-copy-format'
import { postPreviewAspect, postProgressCurrent, postProgressSteps } from '@/videobook/post-progress'
import type { AssetRecord } from '@/videobook/workspace-responses'

export function PostProgress({ post }: { post: PostView }) {
  const steps = postProgressSteps(post)
  const current = postProgressCurrent(steps)
  return <ol className="post-progress" aria-label="Post progress">
    {steps.map((step, index) => <li key={step.key} className={step.done ? 'is-done' : step.key === current ? 'is-current' : undefined} aria-current={step.key === current ? 'step' : undefined}>
      <span className="post-progress-mark" aria-hidden="true">{step.done ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
      <span>{step.label}</span>
    </li>)}
  </ol>
}

function PreviewMedia({ asset }: { asset?: AssetRecord }) {
  if (!asset?.mediaUrl) return <div className="post-preview-empty">No clip yet</div>
  if (asset.type === 'image') return <img src={asset.mediaUrl} alt="Frozen publication media" />
  return <video src={asset.mediaUrl} controls preload="metadata" poster={asset.thumbnailUrl ?? undefined} />
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds) return null
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function PostPreview({ post, asset, caption, credits, account, eyebrow }: {
  post: PostView
  asset?: AssetRecord
  caption: string
  credits: string
  account: string
  eyebrow: string
}) {
  const [overlay, setOverlay] = useState(true)
  const platform = PLATFORM_NAMES[post.definition.platform]
  const duration = formatDuration(asset?.duration)
  const shape = asset?.width && asset.height ? `${asset.width}×${asset.height}` : null
  return <section className="post-preview" aria-label="Post preview">
    <div className="post-preview-meta"><span>{eyebrow}</span><span>{[shape, duration].filter(Boolean).join(' · ')}</span></div>
    <div className="post-preview-frame" style={{ aspectRatio: postPreviewAspect(asset?.width, asset?.height) }}>
      <PreviewMedia asset={asset} />
      {overlay && <div className="post-preview-overlay" aria-hidden="true">
        <strong>{account.trim() || '@account'}</strong>
        <p>{caption.trim() || 'No caption yet'}</p>
        {credits.trim() && <small>{credits}</small>}
      </div>}
    </div>
    <div className="post-preview-toggle" role="group" aria-label="Preview overlay">
      <button type="button" aria-pressed={overlay} onClick={() => setOverlay(true)}>{platform}</button>
      <button type="button" aria-pressed={!overlay} onClick={() => setOverlay(false)}>Clean</button>
    </div>
  </section>
}

export function PlatformPicker({ value, disabled, onChange }: { value: PostPlatform; disabled: boolean; onChange: (platform: PostPlatform) => void }) {
  return <fieldset className="post-platforms" disabled={disabled}>
    <legend>Platform</legend>
    {POST_PLATFORMS.map(name => <label key={name} className={name === value ? 'is-selected' : undefined}>
      <input type="radio" name="post-platform" value={name} checked={name === value} onChange={() => onChange(name)} />
      <span>{name === 'youtube' ? 'YouTube' : PLATFORM_NAMES[name]}</span>
    </label>)}
  </fieldset>
}

export function DeliveryIcon({ to }: { to: 'icloud' | 'download' | 'x' }) {
  if (to === 'icloud') return <Smartphone size={16} aria-hidden="true" />
  if (to === 'download') return <Download size={16} aria-hidden="true" />
  return <Send size={16} aria-hidden="true" />
}

import { useState, type KeyboardEvent } from 'react'
import type { PostView } from '../../../server/src/posts/post-contract'
import { postLinkPrompt } from '@/videobook/post-delivery-review'
import { xPostLocalDateTimeValue } from '@/videobook/x-post-review'

export type PostLinkArgs = { url: string; posted_at: string }

const PLACEHOLDERS: Readonly<Record<PostView['definition']['platform'], string>> = {
  tiktok: 'https://www.tiktok.com/@account/video/…',
  instagram: 'https://www.instagram.com/reel/…',
  youtube: 'https://youtube.com/shorts/…',
  x: 'https://x.com/account/status/…',
  other: 'https://…',
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function PostLinkField({ post, disabled, className, onLink }: {
  post: PostView
  disabled: boolean
  className?: string
  onLink: (args: PostLinkArgs) => Promise<unknown>
}) {
  const [url, setUrl] = useState('')
  const [postedAt, setPostedAt] = useState(() => xPostLocalDateTimeValue(new Date().toISOString()))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = disabled || saving || !post.definition.source
  const save = async () => {
    if (blocked || !url.trim() || !postedAt) return
    setSaving(true)
    setError(null)
    try {
      await onLink({ url: url.trim(), posted_at: new Date(postedAt).toISOString() })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    void save()
  }
  const id = `post-link-${post.id}`
  return (
    <div className={className ?? 'post-link-field'} role="group" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{postLinkPrompt(post)}</h3>
      <label htmlFor={`${id}-url`}>Post URL</label>
      <input id={`${id}-url`} type="url" value={url} disabled={blocked} spellCheck={false} placeholder={PLACEHOLDERS[post.definition.platform]} onChange={event => setUrl(event.target.value)} onKeyDown={onKeyDown} />
      <label htmlFor={`${id}-at`}>Published at</label>
      <input id={`${id}-at`} type="datetime-local" value={postedAt} disabled={blocked} onChange={event => setPostedAt(event.target.value)} onKeyDown={onKeyDown} />
      <button type="button" disabled={blocked || !url.trim() || !postedAt} onClick={() => void save()}>{saving ? 'Saving link…' : 'Save published link'}</button>
      {error && <small role="alert" className="post-error">{error}</small>}
      <small>Locks the clip and caption to this publication. Add views and likes under Results afterwards.</small>
    </div>
  )
}

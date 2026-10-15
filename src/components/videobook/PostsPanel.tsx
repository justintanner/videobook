import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PostView } from '../../../server/src/posts/post-contract'
import './Posts.css'

export function PostsPanel({ posts, loading, error, onClose, onRefresh, onSelect }: {
  posts: PostView[]
  loading: boolean
  error: string | null
  onClose: () => void
  onRefresh: () => Promise<void>
  onSelect: (post: PostView) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  const [sort, setSort] = useState('published')
  const [platform, setPlatform] = useState('all')
  const [age, setAge] = useState('latest')
  const observation = (post: PostView) => {
    if (age === 'latest') return post.runtime.metrics.at(-1)
    const target = Number(age) * 3_600_000
    const start = new Date(post.runtime.postedAt ?? '').getTime()
    return post.runtime.metrics.find(entry => {
      const elapsed = new Date(entry.observedAt).getTime() - start
      return elapsed >= target && elapsed < target + Math.max(3_600_000, target * 0.25)
    })
  }
  const rows = posts.filter(post => platform === 'all' || post.definition.platform === platform).map(post => ({ post, observed: observation(post) })).sort((a, b) => {
    if (sort === 'published') return (b.post.runtime.postedAt ?? b.post.definition.createdAt).localeCompare(a.post.runtime.postedAt ?? a.post.definition.createdAt)
    const key = sort as 'views' | 'likes' | 'impressions'
    return (b.observed?.values[key] ?? -1) - (a.observed?.values[key] ?? -1)
  })
  return createPortal(<dialog ref={dialogRef} className="posts-panel" aria-label="Book posts" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><div><span className="post-eyebrow">This book</span><h2>Posts & results</h2></div><button type="button" onClick={onClose} autoFocus aria-label="Close posts">Close</button></header>
    <div className="posts-filters"><label>Platform<select aria-label="Platform" value={platform} onChange={event => setPlatform(event.target.value)}><option value="all">All platforms</option>{[...new Set(posts.map(post => post.definition.platform))].map(name => <option key={name}>{name}</option>)}</select></label><label>Observation age<select aria-label="Observation age" value={age} onChange={event => setAge(event.target.value)}><option value="latest">Latest observation</option>{[1, 24, 72, 168, 672].map(hours => <option key={hours} value={hours}>{hours < 168 ? `${hours} hours` : `${hours / 24} days`}</option>)}</select></label><label>Sort by<select aria-label="Sort by" value={sort} onChange={event => setSort(event.target.value)}><option value="published">Publication date</option><option value="impressions">Impressions</option><option value="views">Post views</option><option value="likes">Likes</option></select></label><button type="button" onClick={() => void onRefresh()} disabled={loading}>Refresh</button></div>
    <p className="posts-note">Compare observations at similar ages. — means unknown; X media views are shared across publications and shown separately.</p>
    {error && <p role="alert" className="post-error">{error}</p>}
    {loading ? <p role="status">Loading posts…</p> : rows.length === 0 ? <p className="posts-empty">No posts yet. Select a clip and choose Create Post to start tracking a publication.</p> : <div className="posts-table-scroll"><table><thead><tr><th>Post / source</th><th>Platform / status</th><th>Published</th><th>Observed / age</th><th>Views</th><th>Impressions</th><th>Likes</th><th>Replies</th><th>Shares / reposts</th><th>X media views</th></tr></thead><tbody>{rows.map(({ post, observed }) => <tr key={post.id}><td><button type="button" onClick={() => onSelect(post)}>{post.address} · {post.definition.caption.slice(0, 70) || 'Untitled post'}</button><small>{post.definition.lineage.find(item => item.cellId === post.definition.source?.cellId)?.label ?? 'Source clip'}</small></td><td>{post.definition.platform} {post.definition.account}<small>{post.runtime.status.replaceAll('_', ' ')}</small></td><td>{post.runtime.postedAt ? new Date(post.runtime.postedAt).toLocaleDateString() : '—'}{post.runtime.url && <a href={post.runtime.url} target="_blank" rel="noreferrer">Open ↗</a>}</td><td>{observed ? <>{new Date(observed.observedAt).toLocaleString()}<small>{post.runtime.postedAt ? `${Math.max(0, (new Date(observed.observedAt).getTime() - new Date(post.runtime.postedAt).getTime()) / 3_600_000).toFixed(1)}h after publication` : ''} · {observed.source}</small></> : '—'}</td>{(['views', 'impressions', 'likes', 'replies'] as const).map(name => <td key={name}>{observed?.values[name]?.toLocaleString() ?? '—'}</td>)}<td>{(observed?.values.shares ?? observed?.values.reposts)?.toLocaleString() ?? '—'}</td><td>{observed?.mediaViews?.toLocaleString() ?? '—'}</td></tr>)}</tbody></table></div>}
  </dialog>, document.body)
}

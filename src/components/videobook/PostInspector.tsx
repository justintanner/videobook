import { useState } from 'react'
import type { NotebookCell } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { POST_METRIC_NAMES, POST_PLATFORMS } from '../../../server/src/posts/post-contract'
import type { PostDefinition, PostMetrics, PostPlatform, PostView } from '../../../server/src/posts/post-contract'
import { icloudPhoneReceipt, icloudProgressLabel } from '@/videobook/post-delivery-review'
import type { ICloudSyncView } from '@/videobook/post-delivery-review'
import { useIcloudSyncPoll } from '@/videobook/use-icloud-sync-poll'
import type { DeliveryDestination } from '@/videobook/post-delivery-review'
import { usePostActions } from '@/videobook/use-post-actions'
import type { PostToolCall } from '@/videobook/use-post-actions'
import type { AssetRecord } from '@/videobook/workspace-responses'
import { PostLinkField } from './PostLinkField'
import type { PostLinkArgs } from './PostLinkField'
import './Posts.css'

function localObservationTime() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 23)
}

export function PostInspector({ post, cells, asset, bookId, call, onRefresh, onSelectCell, onDeliver, onReviewX, onDelete }: {
  post: PostView
  cells: readonly NotebookCell[]
  asset?: AssetRecord
  bookId: string
  call?: PostToolCall
  onRefresh: () => Promise<unknown>
  onSelectCell: (id: string) => void
  onDeliver: (destination: DeliveryDestination) => void
  onReviewX: (post: PostView) => Promise<unknown>
  onDelete: () => void
}) {
  const actions = usePostActions(call, bookId, onRefresh)
  const [draft, setDraft] = useState<Partial<PostDefinition>>({})
  const platform = draft.platform ?? post.definition.platform
  const caption = draft.caption ?? post.definition.caption
  const credits = draft.credits ?? post.definition.credits
  const account = draft.account ?? post.definition.account
  const notes = draft.notes ?? post.definition.notes
  const [sourceId, setSourceId] = useState('')
  const [observedAt, setObservedAt] = useState(localObservationTime)
  const [metrics, setMetrics] = useState<Record<string, string>>({})
  const [sync, setSync] = useState<ICloudSyncView | null>(null)
  useIcloudSyncPoll(Boolean(post.runtime.icloud?.completedAt), call, bookId, post.id, setSync)
  const icloudProgress = icloudProgressLabel(sync?.phase ?? null, sync?.error)
  const locked = Boolean(post.runtime.outbound || post.runtime.url || post.runtime.status === 'scheduled')
  const source = cells.find(cell => cell.id === post.definition.source?.cellId)
  const latest = post.runtime.metrics.at(-1)
  const dirty = platform !== post.definition.platform || caption !== post.definition.caption || credits !== post.definition.credits || account !== post.definition.account
  const run = (tool: string, args: Record<string, unknown> = {}) => actions.run(tool, { post_cell_id: post.id, ...args })
  const link = async (args: PostLinkArgs) => {
    if (!call) return
    await call('link_post', { book_id: bookId, post_cell_id: post.id, ...args })
    await onRefresh()
  }
  return <section className="post-inspector" aria-label="Post details">
    <div className="post-heading"><div><span className="post-eyebrow">{post.definition.platform} publication</span><h2>{post.address} · Post</h2></div><span className={`post-status post-status-${post.runtime.status}`}>{post.runtime.status.replaceAll('_', ' ')}</span></div>
    {asset?.mediaUrl && (asset.type === 'image' ? <img className="post-media" src={asset.mediaUrl} alt="Frozen publication media" /> : <video className="post-media" src={asset.mediaUrl} controls preload="metadata" poster={asset.thumbnailUrl ?? undefined} />)}
    <div className="post-source">
      {source ? <button type="button" onClick={() => onSelectCell(source.id)}>Source {notebookGridTag(source.slot)} · {source.label ?? source.type}</button> : post.definition.source ? <span>Source cell no longer on this canvas</span> : <span>Choose the finished clip this publication will represent.</span>}
      {post.definition.source && <small>{post.definition.source.revision ? `Clip version saved ${new Date(post.definition.createdAt).toLocaleString()}` : 'Historical media version unknown'}</small>}
    </div>
    {!post.definition.source && <form onSubmit={event => { event.preventDefault(); void run('update_post', { source_cell_id: sourceId }) }}>
      <label>Source clip<select aria-label="Source clip" value={sourceId} onChange={event => setSourceId(event.target.value)} required><option value="">Choose a finished image or video</option>{cells.filter(cell => cell.type !== 'post' && cell.outputArtifactId && ['image', 'video', 'generate_image', 'generate_video', 'concat', 'splice', 'split_video'].includes(cell.type)).map(cell => <option key={cell.id} value={cell.id}>{notebookGridTag(cell.slot)} · {cell.label ?? cell.type}</option>)}</select></label>
      <button disabled={actions.busy || !sourceId}>Save source version</button>
    </form>}
    <form onSubmit={event => { event.preventDefault(); void run('update_post', locked ? { notes } : { platform, caption, credits, account, notes }).then(saved => { if (saved) setDraft({}) }) }}>
      <div className="post-fields"><label>Platform<select aria-label="Platform" disabled={locked} value={platform} onChange={event => setDraft({ ...draft, platform: event.target.value as PostPlatform })}>{POST_PLATFORMS.map(name => <option key={name} value={name}>{name === 'x' ? 'X' : name}</option>)}</select></label><label>Account<input value={account} disabled={locked} placeholder="@account" onChange={event => setDraft({ ...draft, account: event.target.value })} /></label></div>
      <label>Caption<textarea value={caption} disabled={locked} rows={4} onChange={event => setDraft({ ...draft, caption: event.target.value })} placeholder="What will this post say?" /></label>
      <label>Credits<textarea value={credits} disabled={locked} rows={2} onChange={event => setDraft({ ...draft, credits: event.target.value })} placeholder="Creator and source credits" /></label>
      <label>Notes<textarea value={notes} rows={2} onChange={event => setDraft({ ...draft, notes: event.target.value })} placeholder="What worked? What would you change?" /></label>
      <button disabled={actions.busy || !call}>{locked ? 'Save notes' : 'Save draft'}</button>
    </form>
    {actions.error && <p role="alert" className="post-error">{actions.error}</p>}
    {post.runtime.error && <p role="alert" className="post-error">{post.runtime.error}</p>}
    {!post.runtime.url && <div className="post-delivery">
      <h3>Deliver</h3>
      <p>Review the clip and caption, then save them where you will publish.</p>
      <button type="button" aria-pressed={post.definition.delivery === 'icloud'} onClick={() => onDeliver('icloud')}>Save to iPhone</button>
      <button type="button" aria-pressed={post.definition.delivery === 'dropbox'} onClick={() => onDeliver('dropbox')}>Upload to Dropbox</button>
      {post.definition.platform === 'x' && !post.runtime.xRequest && !['scheduled', 'needs_reconciliation', 'posting'].includes(post.runtime.status) && <button type="button" disabled={actions.busy || !post.definition.source?.snapshotArtifactId || !caption.trim() || dirty} onClick={() => void onReviewX(post)}>Review X post…</button>}
      {post.definition.platform === 'x' && post.runtime.xRequest && post.runtime.status === 'failed' && <button type="button" disabled={actions.busy} onClick={() => void run('post')}>Retry saved X post</button>}
      {dirty && <small>Save your draft before delivering.</small>}
      {post.runtime.scheduledFor && <p>Scheduled for {new Date(post.runtime.scheduledFor).toLocaleString()}</p>}
    </div>}
    {post.runtime.icloud?.completedAt && <div className="post-receipt"><strong>{icloudPhoneReceipt(post.runtime.icloud.folder)}</strong>{icloudProgress && <small>{icloudProgress}</small>}</div>}
    {post.runtime.dropbox && <div className="post-receipt"><strong>{post.runtime.dropbox.completedAt ? 'Dropbox files ready' : 'Dropbox upload saved'}</strong><span>{post.runtime.dropbox.folder}</span><small>Clip: {post.runtime.dropbox.video.rev ? 'uploaded' : `${post.runtime.dropbox.video.offset.toLocaleString()} bytes saved`} · Caption: {post.runtime.dropbox.caption.rev ? 'uploaded' : 'pending'}</small></div>}
    {post.runtime.url ? <div className="post-receipt"><a href={post.runtime.url} target="_blank" rel="noreferrer">Open published post ↗</a><span>{post.runtime.postedAt ? new Date(post.runtime.postedAt).toLocaleString() : 'Publication time unknown'}</span>{post.runtime.x?.replies.map(reply => <a key={reply.tweet_id} href={reply.tweet_url} target="_blank" rel="noreferrer">Open reply ↗</a>)}</div> : <PostLinkField post={post} disabled={actions.busy || !call || dirty} className="post-delivery post-link-field" onLink={link} />}
    {post.runtime.url && <div className="post-results"><h3>Results</h3>
      {latest ? <><div className="post-metric-grid">{POST_METRIC_NAMES.map(name => <div key={name}><strong>{latest.values[name]?.toLocaleString() ?? '—'}</strong><span>{name}</span></div>)}</div><small>Observed {new Date(latest.observedAt).toLocaleString()} · {latest.source}</small>{latest.mediaViews !== undefined && <p>{latest.mediaViews.toLocaleString()} X media views · shared across posts using this media</p>}</> : <p>No observations yet. Unknown metrics appear as —.</p>}
      {post.definition.platform === 'x' && <><button type="button" disabled={actions.busy} onClick={() => void run('refresh_post_metrics')}>Refresh now</button><small>{post.runtime.nextMetricAt ? `Next check ${new Date(post.runtime.nextMetricAt).toLocaleString()}` : post.runtime.metricsPaused ? 'Automatic checks paused; reconnect X and refresh.' : 'Scheduled observations complete.'}</small>{post.runtime.metricsError && <p className="post-error">{post.runtime.metricsError}</p>}</>}
      <details onToggle={event => { if (event.currentTarget.open) setObservedAt(localObservationTime()) }}><summary>Add manual observation</summary><form onSubmit={event => {
        event.preventDefault()
        const values: PostMetrics = {}
        for (const name of POST_METRIC_NAMES) if (metrics[name]?.trim()) values[name] = Number(metrics[name])
        void run('record_post_metrics', { observed_at: new Date(observedAt).toISOString(), values })
      }}><label>Observed at<input type="datetime-local" step="0.001" required value={observedAt} onChange={event => setObservedAt(event.target.value)} /></label><div className="post-metric-inputs">{POST_METRIC_NAMES.map(name => <label key={name}>{name}<input type="number" min="0" step="1" placeholder="Unknown" value={metrics[name] ?? ''} onChange={event => setMetrics({ ...metrics, [name]: event.target.value })} /></label>)}</div><button disabled={actions.busy || !Object.values(metrics).some(Boolean)}>Save observation</button></form></details>
      {post.runtime.metrics.length > 0 && <details><summary>Observation history ({post.runtime.metrics.length})</summary><div className="post-history">{[...post.runtime.metrics].reverse().map(entry => <p key={entry.id ?? `${entry.observedAt}-${entry.source}`}><strong>{new Date(entry.observedAt).toLocaleString()} · {entry.source}</strong><span>{Object.entries(entry.values).map(([name, value]) => `${name}: ${value?.toLocaleString() ?? '—'}`).join(' · ')}</span></p>)}</div></details>}
    </div>}
    <details><summary>Idea → clip → post ({post.definition.lineage.length} source cells)</summary><div className="post-lineage">{post.definition.lineage.map(item => {
      const current = cells.find(cell => cell.id === item.cellId)
      return <div key={item.cellId}>{current ? <button type="button" onClick={() => onSelectCell(current.id)}>{notebookGridTag(current.slot)} · {item.label ?? item.type}</button> : <strong>{item.label ?? item.type}</strong>}{item.prompt && <p>{item.prompt}</p>}</div>
    })}</div></details>
    <button type="button" className="post-delete" onClick={onDelete}>Remove Post cell</button>
  </section>
}

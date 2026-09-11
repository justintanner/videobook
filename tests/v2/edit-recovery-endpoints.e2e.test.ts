import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { v7 as uuidv7 } from 'uuid'
import type { EditIntent, Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sequenceContentRevision } from '../../src/videobook/sequence-revision.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

interface Plan { planId: string; parentActionId?: string; stages: Array<{ intent: EditIntent }> }
interface Preview { valid: boolean; previewHash: string; conflicts: Array<{ code: string }> }
interface Commit { actionId: string; revision: string; sequence: Sequence }

describe('canonical edit and recovery endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let artifactId: string
  let notebookId: string

  const connect = async () => {
    server = await startServer(rootDir)
    client = new Client({ name: 'edit-recovery-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  }
  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const sequence = () => call<Sequence>('get_primary_sequence')
  const plan = (request: Record<string, unknown> | Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    call<Plan>('plan_sequence_edit', { source_surface: 'ui', actor: 'edit-recovery-e2e', request, ...extra })
  const insert = (timeline_start_frame = 0) => ({ kind: 'insert', artifact_id: artifactId, timeline_start_frame, duration_frames: 90 })
  const preview = (intent: EditIntent) => call<Preview>('preview_edit_intent', { intent })
  const commit = async (planned: Plan) => {
    const intent = planned.stages[0]!.intent
    const checked = await preview(intent)
    expect(checked.valid, JSON.stringify(checked)).toBe(true)
    return await call<Commit>('commit_edit_intent', { intent, preview_hash: checked.previewHash })
  }
  const reject = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } })
    expect(result.isError, JSON.stringify(result)).toBe(true)
  }
  const queued = async () => call<Record<string, unknown>>('plan_generation_insert', {
    source_surface: 'ui', actor: 'edit-recovery-e2e',
    generation: { tool: 'generate_kie_nano_banana_pro_text_to_image', input: { prompt: 'A cat' }, provider: 'kie',
      model: 'NanoBananaProRequestSchema', estimated_cost_usd: 0.1,
      track_id: (await sequence()).tracks.find((track) => track.kind === 'video')!.trackId,
      timeline_start_frame: 180, duration_frames: 90 },
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-edit-recovery-'))
    await connect()
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Edit recovery fixture' })).bookId
    notebookId = (await call<Array<{ id: string }>>('list_notebooks'))[0]!.id
    const bytes = await sharp({ create: { width: 80, height: 48, channels: 3, background: '#ac6937' } }).png().toBuffer()
    artifactId = (await call<{ assetId: string }>('upload_file', { filename: 'cat-color.png', data: bytes.toString('base64') })).assetId
    await expect.poll(async () => (await call<Array<{ state: string }>>('list_jobs')).every((job) => job.state === 'done'), { timeout: 30_000 }).toBe(true)
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('keeps planning and previews read-only, rejects tampering, and audits the committed edit', async () => {
    const before = await sequence()
    const planned = await plan(insert())
    const intent = planned.stages[0]!.intent
    const checked = await preview(intent)
    expect(checked.valid).toBe(true)
    expect(await sequence()).toEqual(before)
    await reject('commit_edit_intent', { intent, preview_hash: 'invalid-preview-hash' })
    const changed = { ...intent, operations: intent.operations.map((operation) => operation.kind === 'insert-clip'
      ? { ...operation, placement: { ...operation.placement, durationFrames: 120 } }
      : operation) }
    await reject('commit_edit_intent', { intent: changed, preview_hash: checked.previewHash })
    expect(await sequence()).toEqual(before)
    const committed = await call<Commit>('commit_edit_intent', { intent, preview_hash: checked.previewHash })
    expect(committed.sequence.clips).toHaveLength(1)
    expect(committed.sequence.clips[0]).toMatchObject({ durationFrames: 90, source: { artifactId } })
    const audit = await call<{ baseRevision: string; committedRevision: string; actor: string }>('get_edit_action', { action_id: committed.actionId })
    expect(audit).toMatchObject({ baseRevision: intent.baseRevision, committedRevision: committed.revision, actor: 'edit-recovery-e2e' })
  })

  it('commits only one of six simultaneous identical preview submissions', async () => {
    const intent = (await plan(insert())).stages[0]!.intent
    const checked = await preview(intent)
    const results = await Promise.all(Array.from({ length: 6 }, () => client.callTool({ name: 'commit_edit_intent', arguments: {
      book_id: bookId, intent, preview_hash: checked.previewHash,
    } })))
    expect(results.filter((result) => !result.isError)).toHaveLength(1)
    expect((await sequence()).clips).toHaveLength(1)
  })

  it('rejects a conflicting concurrent edit and stale planning without changing the winner', async () => {
    const committed = await commit(await plan(insert()))
    const clipId = committed.sequence.clips[0]!.clipId
    const intents = await Promise.all([15, 30].map(async (start) => (await plan({ kind: 'trim', clip_id: clipId, timeline_start_frame: start, duration_frames: 45 })).stages[0]!.intent))
    const previews = await Promise.all(intents.map(preview))
    const results = await Promise.all(intents.map((intent, index) => client.callTool({ name: 'commit_edit_intent', arguments: {
      book_id: bookId, intent, preview_hash: previews[index]!.previewHash,
    } })))
    expect(results.filter((result) => !result.isError)).toHaveLength(1)
    const after = await sequence()
    expect(after.clips).toHaveLength(1)
    expect(after.clips[0]!.durationFrames).toBe(45)
    await reject('plan_sequence_edit', { source_surface: 'ui', actor: 'stale', expected_revision: intents[0]!.baseRevision, request: insert(180) })
    expect(await sequence()).toEqual(after)
  })

  it('plans the same compound transform and caption across all three surfaces', async () => {
    const seeded = await commit(await plan(insert()))
    const request = [
      { kind: 'transform', clip_id: seeded.sequence.clips[0]!.clipId, position_x: 0.25, scale_x: 0.75, rotation_degrees: 15, opacity: 0.8 },
      { kind: 'caption', cue_id: uuidv7(), timeline_start_frame: 15, duration_frames: 30, text: 'A curious cat', style_id: 'bold' },
    ]
    const plans = await Promise.all(['ui', 'slash', 'chat'].map((source_surface) => plan(request, { source_surface })))
    for (const planned of plans) expect(planned.stages[0]!.intent.operations).toEqual(plans[0]!.stages[0]!.intent.operations)
    const edited = await commit(plans[0]!)
    expect(edited.sequence.clips[0]!.transform).toMatchObject({ positionX: 0.25, scaleX: 0.75, rotationDegrees: 15, opacity: 0.8 })
    expect(edited.sequence.captions).toHaveLength(1)
    expect(edited.sequence.captions[0]).toMatchObject({ text: 'A curious cat', timelineStartFrame: 15, durationFrames: 30 })
  })

  it('restores by revision and action after restart while preserving notebook cells and media', async () => {
    const original = await sequence()
    const first = await commit(await plan(insert()))
    const cell = await call<{ id: string }>('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'image', output_artifact_id: artifactId, slot: { row: 63, column: 7 } } })
    const second = await commit(await plan(insert(90)))
    await client.close()
    await stopServer(server)
    await connect()
    expect((await sequence()).clips).toEqual(second.sequence.clips)
    const undone = await call<Commit>('restore_edit_action', { target_revision: original.revision, base_revision: (await sequence()).revision, actor: 'restore-e2e', source_surface: 'ui' })
    expect(undone.sequence.clips).toEqual([])
    const restored = await call<Commit>('restore_edit_action', { target_action_id: first.actionId, base_revision: (await sequence()).revision, actor: 'restore-e2e', source_surface: 'chat' })
    expect(restored.sequence.clips).toEqual(first.sequence.clips)
    const notebook = await call<{ cells: Array<{ id: string; output_artifact_id?: string }> }>('get_notebook', { notebook_id: notebookId })
    expect(notebook.cells).toContainEqual(expect.objectContaining({ id: cell.id, output_artifact_id: artifactId }))
    expect(await call('get_edit_action', { action_id: first.actionId })).toMatchObject({ committedRevision: first.revision })
    await reject('restore_edit_action', { target_action_id: first.actionId, base_revision: second.revision, actor: 'stale-restore', source_surface: 'ui' })
    expect((await sequence()).clips).toEqual(first.sequence.clips)
  })

  it('rejects invalid and cross-book inputs without partial sequence mutations', async () => {
    const before = await sequence()
    await reject('plan_sequence_edit', { source_surface: 'ui', actor: 'invalid', request: [insert(), { ...insert(90), artifact_id: uuidv7() }] })
    for (const intent of [{}, { operations: [] }, { operations: [{ kind: 'unknown' }] }]) {
      await reject('preview_edit_intent', { intent })
      await reject('commit_edit_intent', { intent, preview_hash: 'missing' })
    }
    const foreign = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Other edit book' })).bookId
    await reject('plan_sequence_edit', { book_id: foreign, source_surface: 'ui', actor: 'foreign', request: insert() })
    expect(await sequence()).toEqual(before)
  })

  it('continues after notebook edits but requires a fresh destination after a sequence edit', async () => {
    const planned = await queued()
    await call('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'prompt', prompt: 'A cat', slot: { row: 0, column: 0 } } })
    const continued = await call<Plan>('continue_queued_insert', { plan: planned, output_artifact_id: artifactId, actor: 'continue-e2e' })
    expect(continued.parentActionId).toBe(planned.planId)
    await commit(continued)
    const before = await sequence()
    expect(await call('continue_queued_insert', { plan: planned, output_artifact_id: artifactId, actor: 'continue-e2e' })).toMatchObject({ kind: 'stale-continuation' })
    expect(await sequence()).toEqual(before)
  })

  it('accepts the browser content revision across notebook writes and rejects later canvas changes', async () => {
    await commit(await plan(insert()))
    const expected_revision = await sequenceContentRevision(await sequence())
    await call('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'prompt', prompt: 'A cat', slot: { row: 0, column: 0 } } })
    const planned = await plan(insert(90), { expected_revision })
    expect((await preview(planned.stages[0]!.intent)).valid).toBe(true)
    const timeline = await call<{ slots: unknown[] }>('get_timeline')
    await call('set_timeline', { render: 'portrait', slots: timeline.slots })
    await reject('plan_sequence_edit', { source_surface: 'ui', actor: 'browser-stale', expected_revision, request: insert(90) })
    const refreshed = await plan(insert(90), { expected_revision: await sequenceContentRevision(await sequence()) })
    expect((await preview(refreshed.stages[0]!.intent)).valid).toBe(true)
  })

  it.each(['canvas', 'transition'] as const)('invalidates a queued insertion after a %s-only change', async (change) => {
    await commit(await plan([insert(), insert(90)]))
    const planned = await queued()
    const current = await sequence()
    if (change === 'canvas') {
      const timeline = await call<{ slots: unknown[] }>('get_timeline')
      await call('set_timeline', { render: 'portrait', slots: timeline.slots })
      expect((await sequence()).clips).toEqual(current.clips)
    } else {
      await commit(await plan({ kind: 'transition', outgoing_clip_id: current.clips[0]!.clipId, incoming_clip_id: current.clips[1]!.clipId,
        transition_kind: 'dissolve', duration_frames: 10, alignment: 'center' }))
    }
    const before = await sequence()
    expect(await call('continue_queued_insert', { plan: planned, output_artifact_id: artifactId, actor: 'continue-e2e' })).toMatchObject({ kind: 'stale-continuation' })
    expect(await sequence()).toEqual(before)
  })
})

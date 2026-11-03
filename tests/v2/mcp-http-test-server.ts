import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/client'
import type { Sequence, SequenceClip } from 'videobook-engine'
import { testBudget } from '../../server/src/test-budget.js'

export interface StartedServer {
  child: ChildProcess
  output: string[]
  url: string
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve an HTTP port')))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

export async function startServer(rootDir: string): Promise<StartedServer> {
  const port = await availablePort()
  const output: string[] = []
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/src/index.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        B2_ACCESS_KEY_ID: '',
        B2_BUCKET: '',
        B2_ENDPOINT: '',
        B2_REGION: '',
        B2_SECRET_ACCESS_KEY: '',
        PORT: String(port),
        VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'runtime', 'app-state.json'),
        VIDEOBOOK_LIBRARY_DIR: join(rootDir, 'books'),
        VIDEOBOOK_ARCHIVE_DIR: join(rootDir, 'archive'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (data: Buffer) => output.push(data.toString()))
  child.stderr.on('data', (data: Buffer) => output.push(data.toString()))
  const started = { child, output, url: `http://127.0.0.1:${port}/mcp` }

  for (let attempt = 0; attempt < testBudget(150); attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited during startup:\n${output.join('')}`)
    }
    try {
      const response = await fetch(started.url)
      if (response.status === 405) return started
    } catch {
      await wait(100)
    }
  }
  throw new Error(`MCP server did not start:\n${output.join('')}`)
}

export async function stopServer(server: StartedServer | undefined): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => server.child.once('exit', () => resolve()))
  server.child.kill('SIGINT')
  const stopped = await Promise.race([
    exited.then(() => true),
    wait(testBudget(5_000)).then(() => false),
  ])
  if (stopped) return
  server.child.kill('SIGKILL')
  await exited
}

export async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    const message = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
    throw new Error(`${name} failed: ${message}`)
  }
  const content = result.content.find((item) => item.type === 'text')
  if (!content || content.type !== 'text') {
    throw new Error(`${name} did not return text content`)
  }
  return JSON.parse(content.text) as T
}

interface PlannedEdit { stages: Array<{ intent: Record<string, unknown> }> }
interface EditPreview { valid: boolean; previewHash: string }

async function commitSequenceEdit(client: Client, bookId: string, current: Sequence, edit: Record<string, unknown>): Promise<Sequence> {
  const planned = await callTool<PlannedEdit>(client, 'plan_sequence_edit', {
    book_id: bookId, source_surface: 'ui', actor: 'e2e', expected_revision: current.revision, edits: [edit],
  })
  const intent = planned.stages[0]?.intent
  if (!intent) throw new Error('plan_sequence_edit returned no stage')
  const preview = await callTool<EditPreview>(client, 'preview_edit_intent', { book_id: bookId, intent })
  if (!preview.valid) throw new Error(`${String(edit.kind)} preview is invalid: ${JSON.stringify(preview)}`)
  await callTool(client, 'commit_edit_intent', { book_id: bookId, intent, preview_hash: preview.previewHash })
  return callTool<Sequence>(client, 'get_primary_sequence', { book_id: bookId })
}

export async function appendAudioClip(client: Client, bookId: string, artifactId: string): Promise<SequenceClip> {
  const current = await callTool<Sequence>(client, 'get_primary_sequence', { book_id: bookId })
  const track = current.tracks.find((entry) => entry.kind === 'audio')
  if (!track) throw new Error('The primary sequence has no audio track')
  const updated = await commitSequenceEdit(client, bookId, current, { kind: 'append', track_id: track.trackId, artifact_id: artifactId })
  const clip = updated.clips.find((entry) => entry.trackId === track.trackId
    && entry.source.kind === 'timed' && entry.source.artifactId === artifactId)
  if (!clip) throw new Error('The appended audio clip is missing from the sequence')
  return clip
}

export async function insertIntoSequence(client: Client, bookId: string, artifactId: string): Promise<Extract<SequenceClip, { source: { kind: 'timed' } }>> {
  const current = await callTool<Sequence>(client, 'get_primary_sequence', { book_id: bookId })
  const updated = await commitSequenceEdit(client, bookId, current, { kind: 'insert', artifact_id: artifactId, timeline_start_frame: 0 })
  const clip = updated.clips.find((entry): entry is Extract<SequenceClip, { source: { kind: 'timed' } }> =>
    entry.source.kind === 'timed' && entry.source.artifactId === artifactId)
  if (!clip) throw new Error('The inserted clip is missing from the sequence')
  return clip
}

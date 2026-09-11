import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Fixture { label?: string; timed?: unknown; plain?: unknown }
interface Exported { status: string; path: string }

function transcript(text = 'Hello world') {
  return {
    language_code: 'eng', text,
    words: text.split(' ').map((word, index) => ({ text: word, start: index * 0.5, end: index * 0.5 + 0.4, type: 'word', speaker_id: 'speaker_0' })),
  }
}

describe('transcript endpoints over HTTP MCP', () => {
  let rootDir: string
  let downloads: string
  let server: StartedServer | undefined
  let client: Client | undefined
  let bookId: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-transcript-http-'))
    downloads = join(rootDir, 'downloads')
    await mkdir(downloads)
  })

  afterEach(async () => {
    await client?.close()
    client = undefined
    await stopServer(server)
    server = undefined
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client!, name, { book_id: bookId, ...args })
  const start = async (fixtures: Fixture[]) => {
    const books = new BookManager({ libraryDir: join(rootDir, 'books') })
    const ids: string[] = []
    try {
      await books.ready()
      const created = await books.create('Transcript fixtures')
      if (!created.ok) throw new Error(created.error.message)
      bookId = created.value.bookId
      const book = books.get(bookId)
      if (!book.ok) throw new Error(book.error.message)
      const engine = book.value.engine
      const audioPath = join(rootDir, 'fixture.wav')
      await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', audioPath])
      for (const fixture of fixtures) {
        const artifact = await engine.artifacts.create({ kind: 'audio', label: fixture.label ?? 'Subtitle fixture' })
        if (!artifact.ok) throw new Error(artifact.error.message)
        const id = artifact.value.artifactId
        ids.push(id)
        const media = await engine.files.writeFromPath(id, 'original.wav', audioPath)
        if (!media.ok) throw new Error(media.error.message)
        for (const [filename, value] of [['elevenlabs.json', fixture.timed], ['.analysis.gpt4otrans.json', fixture.plain]] as const) {
          if (value === undefined) continue
          const written = await engine.files.write(id, filename, JSON.stringify(value))
          if (!written.ok) throw new Error(written.error.message)
        }
      }
    } finally { await books.close() }
    server = await startServer(rootDir)
    client = new Client({ name: 'transcript-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    return ids
  }
  const exported = (id: string) => call<Exported>('export_transcript_srt', { asset_id: id, downloads_dir: downloads })

  it('reads timed speech and untouched raw sidecars while excluding spacing and audio events', async () => {
    const timed = transcript()
    timed.words.push({ text: ' ', start: 1, end: 1.1, type: 'spacing', speaker_id: 'speaker_0' })
    timed.words.push({ text: '[laughter]', start: 1.1, end: 2, type: 'audio_event', speaker_id: 'speaker_0' })
    const [id] = await start([{ timed, plain: { text: 'Fallback words' } }])
    const read = await call<{ kind: string; text: string; words: unknown[] }>('read_transcript', { asset_id: id })
    expect(read).toMatchObject({ kind: 'timed', text: 'Hello world' })
    expect(read.words).toHaveLength(2)
    expect(read.words[0]).toMatchObject({ text: 'Hello', start: 0, end: 0.4, speaker_id: 'speaker_0' })
    expect(await call('read_transcript', { asset_id: id, raw: true })).toEqual({ source: 'elevenlabs', file: 'elevenlabs.json', text: JSON.stringify(timed) })
    expect(await call('read_transcript', { asset_id: id, raw: true, source: 'plain' })).toMatchObject({ text: JSON.stringify({ text: 'Fallback words' }) })
    const result = await exported(id!)
    const srt = await readFile(result.path, 'utf8')
    expect(srt).toContain('00:00:00,000 --> 00:00:00,900')
    expect(srt).toContain('Hello world')
    expect(srt).not.toContain('laughter')
  })

  it('distinguishes missing, plain and silent transcripts and refuses untimed exports', async () => {
    const ids = await start([{}, { plain: { text: 'A plain transcript has words but no word timings.' } }, { timed: { words: [] } }])
    for (const [index, kind] of ['missing', 'plain', 'silence'].entries()) {
      expect(await call('read_transcript', { asset_id: ids[index] })).toMatchObject({ kind })
      const result = await client!.callTool({ name: 'export_transcript_srt', arguments: { book_id: bookId, asset_id: ids[index], downloads_dir: downloads } })
      expect(result.isError).toBe(true)
    }
    expect(await readdir(downloads)).toEqual([])
  })

  it('exports the same first channel selected by transcript reading', async () => {
    const [id] = await start([{ timed: { transcripts: [transcript('First channel'), transcript('Second channel')] } }])
    expect(await call('read_transcript', { asset_id: id })).toMatchObject({ kind: 'timed', text: 'First channel' })
    const result = await exported(id!)
    expect(await readFile(result.path, 'utf8')).toContain('First channel')
    expect(await readFile(result.path, 'utf8')).not.toContain('Second channel')
  })

  it('reconstructs readable text when word timings omit the full text field', async () => {
    const [id] = await start([{ timed: { words: transcript().words } }])
    expect(await call('read_transcript', { asset_id: id })).toMatchObject({ text: 'Hello world' })
  })

  it('keeps existing files and creates distinct files for simultaneous exports with identical labels', async () => {
    const ids = await start([{ timed: transcript('First source') }, { timed: transcript('Second source') }])
    const existing = join(downloads, 'Subtitle fixture.srt')
    await writeFile(existing, 'Existing download')
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => exported(ids[index % 2]!)))
    expect(new Set(results.map((result) => result.path)).size).toBe(12)
    for (const [index, result] of results.entries()) {
      expect(dirname(result.path)).toBe(downloads)
      expect(await readFile(result.path, 'utf8')).toContain(index % 2 === 0 ? 'First source' : 'Second source')
    }
    expect(await readFile(existing, 'utf8')).toBe('Existing download')
    expect(await readdir(downloads)).toHaveLength(13)
  })

  it('treats a dangling symlink as an occupied download filename', async () => {
    const [id] = await start([{ timed: transcript() }])
    const target = join(rootDir, 'symlink-target.srt')
    const link = join(downloads, 'Subtitle fixture.srt')
    await symlink(target, link)
    const result = await exported(id!)
    expect(result.path).not.toBe(link)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(result.path, 'utf8')).toContain('Hello world')
  })

  it('flattens display labels into one safe filename', async () => {
    const [id] = await start([{ label: '../../model\\output / captions', timed: transcript() }])
    const result = await exported(id!)
    expect(dirname(result.path)).toBe(downloads)
    expect(basename(result.path)).toBe('model - output - captions.srt')
    expect(await readdir(downloads)).toEqual([basename(result.path)])
  })
})

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import sharp from 'sharp'
import type { Sequence } from 'videobook-engine'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import type { MusicAnalysisState, RhythmState } from '../../server/src/rhythm/model.js'
import { availablePort, resultValue, startProcess, stopProcess, toolCalls, waitForHttp } from './e2e-harness.js'
import type { StartedProcess } from './e2e-harness.js'

const exec = promisify(execFile)

describe('music video recovery and export in the browser', () => {
  let root = ''
  let server: StartedProcess | undefined
  let vite: StartedProcess | undefined
  let browser: Browser
  let client: Client
  let page: Page
  let origin = ''
  let appUrl = ''
  let bookId = ''
  let songId = ''
  let errors: string[] = []
  let bookNumber = 0
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => resultValue(await client.callTool({ name, arguments: { book_id: bookId, ...args } })) as T
  const sequence = () => call<Sequence>('get_primary_sequence')
  const rhythm = async () => call<RhythmState>('get_sequence_rhythm', { sequence_id: (await sequence()).sequenceId })
  const editor = () => page.getByRole('dialog', { name: 'Music video editor', exact: true })
  const panel = () => editor().locator('.music-rhythm-controls')
  const tab = (name: string) => editor().locator('.timeline-music-toolbar').getByRole('button', { name, exact: true }).click()

  async function openEditor() {
    const input = page.getByLabel('Videobook command input', { exact: true })
    await expect.poll(() => input.isEnabled(), { timeout: 30_000 }).toBe(true)
    await input.fill('/music-video @a1')
    await page.getByRole('button', { name: 'Send command', exact: true }).click()
    await editor().waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => editor().locator('.music-video-setup-card').getAttribute('data-status'), { timeout: 30_000 }).not.toBe('loading')
  }

  async function setupSoundtrack() {
    await openEditor()
    const create = editor().getByRole('button', { name: 'Create soundtrack track', exact: true })
    if (await create.isVisible()) await create.click()
    await editor().getByRole('button', { name: 'Apply soundtrack', exact: true }).click()
    await expect.poll(() => editor().locator('.music-video-setup-card').getAttribute('data-status'), { timeout: 30_000 }).toBe('applied')
    await tab('Soundtrack')
    await panel().getByRole('button', { name: 'Analyze beats', exact: true }).click()
    await expect.poll(() => editor().locator('.timeline-track-audio .timeline-beat').count(), { timeout: 30_000 }).toBeGreaterThan(8)
    await expect.poll(() => panel().getByRole('button', { name: 'Analyze again', exact: true }).isEnabled()).toBe(true)
  }

  async function setGrid() {
    await panel().getByLabel('BPM', { exact: true }).fill('120')
    await panel().getByLabel('Beats per bar', { exact: true }).fill('4')
    await panel().getByRole('button', { name: 'Set grid from playhead', exact: true }).click()
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'videobook-music-ui-'))
    await mkdir(join(root, 'downloads'))
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.3*sin(2*PI*880*t)*lt(mod(t\\,0.5)\\,0.06):s=48000:d=8', '-c:a', 'pcm_s16le', join(root, 'song.wav')])
    await exec(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=90x160:r=30:d=4', '-vf', 'drawbox=x=0:y=0:w=iw:h=12:c=lime:t=fill,drawbox=x=0:y=148:w=iw:h=12:c=blue:t=fill', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(root, 'portrait.mp4')])
    const port = await availablePort()
    origin = `http://127.0.0.1:${port}`
    const env = { ...process.env, PORT: String(port), VIDEOBOOK_LIBRARY_DIR: join(root, 'books'), VIDEOBOOK_APP_STATE_PATH: join(root, 'runtime/app-state.json'), VIDEOBOOK_DOWNLOADS_DIR: join(root, 'downloads') }
    server = startProcess(['--import', 'tsx', 'server/src/index.ts'], env)
    await waitForHttp(`${origin}/healthz`, server, 200)
    client = new Client({ name: 'music-video-ui-e2e', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
    const vitePort = await availablePort()
    appUrl = `http://127.0.0.1:${vitePort}`
    vite = startProcess(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { ...env, VIDEOBOOK_SERVER_URL: origin, VIDEOBOOK_VITE_CACHE_DIR: join(root, 'vite-cache'), VIDEOBOOK_VITE_HMR: '0' })
    await waitForHttp(appUrl, vite, 200)
    browser = await chromium.launch({ headless: true })
  }, 60_000)

  beforeEach(async () => {
    bookId = (await call<{ bookId: string }>('create_book', { name: `music-ui-${++bookNumber}` })).bookId
    const notebook = (await call<Array<{ id: string }>>('list_notebooks'))[0]!
    for (const [column, filename, type] of [[0, 'song.wav', 'audio'], [1, 'portrait.mp4', 'video']] as const) {
      const uploaded = await call<{ assetId: string }>('upload_file', { filename, data: (await readFile(join(root, filename))).toString('base64') })
      if (type === 'audio') songId = uploaded.assetId
      await call('create_notebook_cell', { notebook_id: notebook.id, cell: { type, slot: { row: 0, column }, output_artifact_id: uploaded.assetId } })
    }
    await expect.poll(async () => (await call<Array<{ state: string }>>('list_jobs')).every(job => job.state === 'done'), { timeout: 30_000 }).toBe(true)
    errors = []
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(id => localStorage.setItem('videobook.active-book', id), bookId)
    await page.goto(appUrl)
  }, 60_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      const name = `/tmp/videobook-music-ui-${bookNumber}`
      await page.screenshot({ path: `${name}.png` })
      await writeFile(`${name}.txt`, await page.locator('body').innerText())
    }
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
    await client?.close()
    await stopProcess(vite)
    await stopProcess(server)
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('recovers incomplete and stale drafts, then exports the reviewed video and restores its beats after reload', async () => {
    await setupSoundtrack()
    await setGrid()
    await panel().getByText('Using your corrected beat map.', { exact: false }).waitFor()
    const savedAudio = (await sequence()).clips
    await tab('Sources')
    await editor().locator('.music-video-source-list button').filter({ hasText: 'portrait' }).click()
    await editor().locator('.music-draft-controls summary').click()
    await editor().getByLabel('Keep existing clips', { exact: true }).uncheck()
    await editor().getByRole('button', { name: 'Preview draft', exact: true }).click()
    await editor().getByText('Uncovered:', { exact: false }).first().waitFor()
    expect(await editor().getByRole('button', { name: 'Apply draft', exact: true }).isDisabled()).toBe(true)
    expect((await sequence()).clips).toEqual(savedAudio)
    await editor().getByRole('button', { name: 'Cancel draft', exact: true }).click()
    await editor().getByLabel('Allow repeated footage', { exact: true }).check()
    await editor().getByRole('button', { name: 'Preview draft', exact: true }).click()
    await editor().getByRole('button', { name: 'Apply draft', exact: true }).waitFor()
    const state = await rhythm()
    await call('update_sequence_rhythm', { sequence_id: (await sequence()).sequenceId, expected_revision: state.revision, operation: 'set', settings: { ...state.settings, correction: { ...state.settings.correction!, markers: state.settings.correction!.markers.map((marker, index) => index === 0 ? { ...marker, timeSeconds: 0.1 } : marker) } } })
    await editor().getByRole('button', { name: 'Apply draft', exact: true }).click()
    await expect.poll(() => editor().getByRole('alert').allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/beat.*changed|rhythm.*changed/i)]))
    expect((await sequence()).clips).toEqual(savedAudio)
    await editor().getByRole('button', { name: 'Cancel draft', exact: true }).click()
    await tab('Soundtrack')
    await panel().getByRole('button', { name: 'Reload beats', exact: true }).click()
    await expect.poll(() => panel().getByRole('button', { name: 'Reload beats', exact: true }).isEnabled()).toBe(true)
    await tab('Sources')
    await editor().getByRole('button', { name: 'Preview draft', exact: true }).click()
    await editor().getByRole('button', { name: 'Apply draft', exact: true }).click()
    await expect.poll(async () => (await sequence()).clips.length, { timeout: 30_000 }).toBeGreaterThan(3)
    const applied = await sequence()
    expect(applied.clips.filter(clip => savedAudio.some(audio => audio.clipId === clip.clipId))).toEqual(savedAudio)
    await editor().getByRole('button', { name: 'Hide tools', exact: true }).click()
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const pixels = await sharp(await editor().locator('.timeline-preview-stage').screenshot()).removeAlpha().raw().toBuffer()
        let green = 0
        let blue = 0
        for (let index = 0; index < pixels.length; index += 3) {
          if (pixels[index + 1]! > 150 && pixels[index]! < 100 && pixels[index + 2]! < 100) green++
          if (pixels[index + 2]! > 150 && pixels[index]! < 100 && pixels[index + 1]! < 100) blue++
        }
        return Math.min(green, blue)
      }).toBeGreaterThan(100)
      await page.screenshot({ path: `/tmp/videobook-music-reviewed-${viewport.width}.png` })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await editor().locator('.music-video-header-actions').getByRole('button', { name: 'Export', exact: true }).click()
    await editor().waitFor({ state: 'detached' })
    const review = page.getByRole('dialog', { name: 'Command plan review', exact: true })
    await review.waitFor()
    await review.getByRole('button', { name: /^Apply/ }).click()
    type Job = { type: string; state: string; error?: unknown; result?: { artifactId: string } }
    await expect.poll(async () => (await call<Job[]>('list_jobs')).find(job => job.type === 'export_sequence')?.state, { timeout: 90_000 }).toBe('done')
    const output = (await call<Job[]>('list_jobs')).find(job => job.type === 'export_sequence')!.result!.artifactId
    const url = `${origin}/files/${bookId}/${output}/original.mp4`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    const path = join(root, 'reviewed-export.mp4')
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    const media = await probeVideo(path)
    expect(media.videoDuration).toBeCloseTo(8, 1)
    expect(media.audioDuration).toBeCloseTo(8, 1)
    const pixels = (await exec(FFMPEG, ['-v', 'error', '-ss', '1', '-i', path, '-vf', 'scale=160:90', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 100_000 })).stdout
    const rgb = (x: number, y: number) => [...pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)]
    expect(rgb(80, 2)[1]).toBeGreaterThan(150)
    expect(rgb(80, 87)[2]).toBeGreaterThan(150)
    expect(Math.max(...rgb(5, 45))).toBeLessThan(15)
    const pcm = (await exec(FFMPEG, ['-v', 'error', '-i', path, '-t', '0.4', '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 20_000 })).stdout
    const rms = (start: number, end: number) => {
      let energy = 0
      for (let index = start; index < end; index++) energy += pcm.readFloatLE(index * 4) ** 2
      return Math.sqrt(energy / (end - start))
    }
    expect(rms(160, 320)).toBeGreaterThan(0.1)
    expect(rms(1600, 2400)).toBeLessThan(0.003)
    const playback = await browser.newPage()
    try {
      await playback.goto(url)
      const video = playback.locator('video')
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2)
      await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; element.currentTime = 3; await element.play() })
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(3.1)
    } finally { await playback.close() }
    await page.reload()
    await openEditor()
    await panel().getByText('Using your corrected beat map.', { exact: false }).waitFor()
    expect((await sequence()).clips).toEqual(applied.clips)
    expect(errors).toEqual([])
  }, 180_000)

  it('keeps a saved beat correction usable when the following analysis read loses its connection', async () => {
    await setupSoundtrack()
    let dropAnalysisRead = true
    await page.route('**/mcp', async route => {
      const body = route.request().postDataJSON() as unknown
      if (dropAnalysisRead && toolCalls(body).some(call => call.name === 'get_music_analysis')) await route.abort('connectionreset')
      else await route.continue()
    })
    await setGrid()
    await expect.poll(async () => (await rhythm()).settings.correction?.bpm).toBe(120)
    await expect.poll(() => panel().getByRole('alert').count()).toBeGreaterThan(0)
    expect(await panel().getByText('Using your corrected beat map.', { exact: false }).isVisible()).toBe(true)
    dropAnalysisRead = false
    await panel().getByRole('button', { name: 'Undo beat change', exact: true }).click()
    await expect.poll(async () => (await rhythm()).settings.correction).toBeNull()
    await panel().getByRole('button', { name: 'Redo beat change', exact: true }).click()
    await expect.poll(async () => (await rhythm()).settings.correction?.bpm).toBe(120)
    const before = (await rhythm()).settings.correction
    const previousAnalysis = await call<MusicAnalysisState>('get_music_analysis', { asset_id: songId })
    await panel().getByRole('button', { name: 'Analyze again', exact: true }).click()
    await expect.poll(async () => (await call<MusicAnalysisState>('get_music_analysis', { asset_id: songId })).jobId).not.toBe(previousAnalysis.jobId)
    await expect.poll(async () => (await call<MusicAnalysisState>('get_music_analysis', { asset_id: songId })).status, { timeout: 30_000 }).toBe('ready')
    expect((await rhythm()).settings.correction).toEqual(before)
    expect(errors).toEqual([])
  }, 90_000)
})

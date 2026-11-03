import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import { coldOpenSource } from '../../server/src/cold-open.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { processVideoFiles } from '../../server/src/jobs/process-video.js'
import { musicSource } from '../../server/src/rhythm/music-analysis.js'
import { editingMomentsDefs } from '../../server/src/tools/editing-moments.js'

const execFileAsync = promisify(execFile)

describe('processed .mov uploads', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('read the derived original.mp4 that carries the registered streams', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-mov-sources-'))
    const upload = join(rootDir, 'original.mov')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      upload,
    ])
    const engine = createEngine({ durableWrites: false, rootDir: join(rootDir, 'book'),
    initialBookName: 'mov-sources', })
    await engine.ready
    const artifact = await engine.artifacts.create('video', 'mov upload')
    if (!artifact.ok) throw new Error(artifact.error.message)
    const artifactId = artifact.value.artifactId
    await processVideoFiles(engine, {
      type: 'process_video',
      videoPath: upload,
      assetId: artifactId,
      assetDir: artifact.value.path,
      bookId: engine.book.get().bookId,
      provenance: { origin: 'integration-test' },
      skipDownstreamJobs: true,
    })
    const manifest = await engine.files.manifest(artifactId)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const mp4 = manifest.value.files.find((file) => file.name === 'original.mp4')!
    expect(manifest.value.files.map((file) => file.name)).toEqual(expect.arrayContaining(['original.mov', 'original.mp4']))
    expect(engine.streams.list(artifactId)).toMatchObject({
      ok: true,
      value: [
        { kind: 'video', sourcePath: 'original.mp4', objectHash: mp4.objectHash },
        { kind: 'audio', sourcePath: 'original.mp4', objectHash: mp4.objectHash },
      ],
    })

    expect(await coldOpenSource(engine, artifactId)).toMatchObject({
      file: { name: 'original.mp4', objectHash: mp4.objectHash },
      path: join(manifest.value.path, 'original.mp4'),
    })
    expect(await musicSource(engine, artifactId)).toMatchObject({
      objectHash: mp4.objectHash,
      inputPath: join(manifest.value.path, 'original.mp4'),
    })
    const tools = new Map(editingMomentsDefs(engine).map((tool) => [tool.name, tool]))
    const moments = await tools.get('get_editing_moments')!.handler({
      book_id: engine.book.get().bookId,
      asset_id: artifactId,
    })
    expect(moments.isError, JSON.stringify(moments.content)).toBeUndefined()
    expect(JSON.parse(moments.content[0]!.text)).toMatchObject({ status: 'missing', moments: null })
    engine.close()
  })
})

import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import { contentStoreFromEnvironment } from '../../server/src/content-store.js'

it('verifies remote media from the application B2 adapter before hydration and supports offline reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videobook-b2-integrity-'))
  const keys = ['B2_ACCESS_KEY_ID', 'B2_SECRET_ACCESS_KEY', 'B2_REGION', 'B2_BUCKET', 'B2_ENDPOINT']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  const requests: string[] = []
  const good = Buffer.from('valid media bytes')
  let body = Buffer.from('wrong media bytes')
  expect(body.length).toBe(good.length)
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', body.length)
    response.end(body)
  })
  let engine: ReturnType<typeof createEngine> | undefined
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture address')
    process.env.B2_ACCESS_KEY_ID = 'fixture-access'
    process.env.B2_SECRET_ACCESS_KEY = 'fixture-secret'
    process.env.B2_REGION = 'us-west-004'
    process.env.B2_BUCKET = 'fixture-bucket'
    process.env.B2_ENDPOINT = `http://127.0.0.1:${address.port}`
    const remoteObjects = contentStoreFromEnvironment()
    if (!remoteObjects) throw new Error('No content adapter')
    engine = createEngine({ rootDir: root, initialBookName: 'integrity', remoteObjects, objectPrefix: 'media' })
    await engine.ready
    const artifact = await engine.artifacts.create('video', 'source')
    if (!artifact.ok) throw new Error(artifact.error.message)
    const id = artifact.value.artifactId
    expect((await engine.files.write(id, 'original.mp4', good)).ok).toBe(true)
    const manifest = await engine.files.manifest(id)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const hash = manifest.value.files[0].objectHash
    const cas = join(root, 'data', 'objects', 'sha256', hash.slice(0, 2), hash)
    const media = join(manifest.value.path, 'original.mp4')
    const revisions = engine.history.revisions().map((entry) => entry.hash)
    expect((await engine.workspaces.evict(id)).ok).toBe(true)
    engine.close()
    await unlink(cas)
    engine = createEngine({ rootDir: root, remoteObjects, objectPrefix: 'media' })
    await engine.ready
    expect(await engine.files.read(id, 'original.mp4')).toMatchObject({
      ok: false, error: { code: 'OBJECT_UNAVAILABLE', details: { reason: 'checksum_mismatch', objectHash: hash } },
    })
    await expect(stat(cas)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(media)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(root, 'data', 'objects', 'sha256', hash.slice(0, 2)))).filter((name) => name.endsWith('.download'))).toEqual([])
    expect(engine.history.revisions().map((entry) => entry.hash)).toEqual(revisions)
    body = good
    expect(await engine.files.read(id, 'original.mp4')).toMatchObject({ ok: true, value: good })
    expect(await readFile(cas)).toEqual(good)
    expect(await readFile(media)).toEqual(good)
    expect(requests).toEqual(Array(2).fill(`GET /fixture-bucket/media/${hash.slice(0, 2)}/${hash}`))
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    expect(await engine.files.read(id, 'original.mp4')).toMatchObject({ ok: true, value: good })
    expect(engine.history.revisions().map((entry) => entry.hash)).toEqual(revisions)
  } finally {
    engine?.close()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

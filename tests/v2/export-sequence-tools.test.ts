import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MVP_CONTRACT_VERSION,
  createEngine,
  type EditIntent,
} from 'videobook-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { exportSequenceDefs } from '../../server/src/tools/export-sequence.js'

function resultJson(result: {
  isError?: true
  content: Array<{ type: 'text'; text: string }>
}): unknown {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed')
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('canonical sequence export tools', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('validates immutable inputs and creates a revision-pinned queued export plan', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-export-plan-'))
    const engine = createEngine({ durableWrites: false, rootDir,
    initialBookName: 'export-plan', })
    const artifact = await engine.artifacts.create('image', 'frame')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from('image-bytes'),
    )).ok).toBe(true)
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const sequence = engine.sequences.getPrimary()
    const videoTrack = sequence.tracks.find((track) => track.kind === 'video')
    expect(videoTrack).toBeTruthy()
    if (!videoTrack) return
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId: sequence.sequenceId,
      baseRevision: engine.head,
      actor: 'export-fixture',
      sourceSurface: 'ui',
      confirmationPolicy: 'reversible-single-step',
      operations: [{
        kind: 'insert-clip',
        mode: 'insert',
        placement: {
          trackId: videoTrack.trackId,
          timelineStartFrame: 0,
          durationFrames: 60,
          source: {
            kind: 'still',
            artifactId: artifact.value.artifactId,
            sourcePath: 'original.png',
            objectHash,
          },
        },
      }],
    }
    const preview = engine.edits.preview(intent)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const commit = await engine.edits.commit(intent, preview.value.previewHash)
    expect(commit.ok).toBe(true)
    if (!commit.ok) return
    const tools = new Map(exportSequenceDefs(engine).map((tool) => [tool.name, tool]))
    const validation = resultJson(
      await tools.get('validate_sequence_export')!.handler({
        book_id: engine.book.get().bookId,
        sequence_revision: engine.head,
        orientation: 'portrait',
        captions: 'sidecar',
      }),
    ) as {
      valid: boolean
      width: number
      height: number
      durationFrames: number
      inputObjectHashes: string[]
    }
    expect(validation).toMatchObject({
      valid: true,
      width: 1080,
      height: 1920,
      durationFrames: 60,
      inputObjectHashes: [objectHash],
    })
    const plan = resultJson(
      await tools.get('plan_sequence_export')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'slash',
        actor: 'export-fixture',
        sequence_revision: engine.head,
        orientation: 'portrait',
        captions: 'sidecar',
      }),
    ) as {
      sourceSurface: string
      confirmation: { required: boolean }
      stages: Array<Record<string, unknown>>
    }
    expect(plan).toMatchObject({
      sourceSurface: 'slash',
      confirmation: { required: true },
      stages: [
        {
          kind: 'export',
          revision: engine.head,
          orientation: 'portrait',
          captions: 'sidecar',
        },
        {
          kind: 'queued',
          jobType: 'export',
          tool: 'export_sequence',
          insertsOutput: false,
        },
      ],
    })
    const stale = resultJson(
      await tools.get('validate_sequence_export')!.handler({
        book_id: engine.book.get().bookId,
        sequence_revision: sequence.revision,
        orientation: 'landscape',
        captions: 'burn-in',
      }),
    ) as { valid: boolean; errors: Array<{ code: string }> }
    expect(stale).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'STALE_REVISION' }),
      ]),
    })
    engine.close()
  })
})

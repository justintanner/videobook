import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  MVP_CONTRACT_VERSION,
  createEngine,
  type EditIntent,
} from 'videobook-engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerExportSequenceJob } from '../../server/src/jobs/export-sequence.js'
import { queue, setEngineRoot } from '../../server/src/queue.js'

const execFileAsync = promisify(execFile)
describe('canonical sequence export renderer', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    vi.unstubAllGlobals()
    await queue.stop()
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('renders a revision-pinned MP4 offline and records immutable provenance', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-export-render-'))
    const sourcePath = join(rootDir, 'fixture.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=1:size=320x180:rate=30',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-shortest',
      sourcePath,
    ])
    const sourceProbe = await probeVideo(sourcePath)
    const engine = createEngine({
      rootDir,
      initialBookName: 'export-render',
    })
    const artifact = await engine.artifacts.create('video', 'fixture')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const stored = await engine.files.writeFromPath(
      artifact.value.artifactId,
      'original.mp4',
      sourcePath,
    )
    expect(stored.ok).toBe(true)
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash || !sourceProbe.videoStream) return
    const videoStream = await engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.mp4',
      objectHash,
      streamIndex: sourceProbe.videoStream.index,
      kind: 'video',
      timeBase: sourceProbe.videoStream.timeBase,
      durationTicks: sourceProbe.videoStream.durationTicks,
      codec: sourceProbe.videoStream.codec,
      video: sourceProbe.videoStream.video!,
    })
    expect(videoStream.ok).toBe(true)
    expect(sourceProbe.audioStream).toBeTruthy()
    if (!sourceProbe.audioStream) return
    expect((await engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.mp4',
      objectHash,
      streamIndex: sourceProbe.audioStream.index,
      kind: 'audio',
      timeBase: sourceProbe.audioStream.timeBase,
      durationTicks: sourceProbe.audioStream.durationTicks,
      codec: sourceProbe.audioStream.codec,
      audio: sourceProbe.audioStream.audio!,
    })).ok).toBe(true)
    if (!videoStream.ok) return
    const sequence = engine.sequences.getPrimary()
    const track = sequence.tracks.find((candidate) => candidate.kind === 'video')
    const captionTrack = sequence.tracks.find((candidate) => candidate.kind === 'caption')
    expect(track).toBeTruthy()
    expect(captionTrack).toBeTruthy()
    if (!track || !captionTrack) return
    const intent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId: sequence.sequenceId,
      baseRevision: engine.head,
      actor: 'export-render-test',
      sourceSurface: 'ui',
      confirmationPolicy: 'reversible-single-step',
      operations: [{
        kind: 'insert-clip',
        mode: 'insert',
        placement: {
          trackId: track.trackId,
          timelineStartFrame: 0,
          durationFrames: 30,
          source: {
            kind: 'timed',
            artifactId: artifact.value.artifactId,
            range: {
              streamId: videoStream.value.streamId,
              objectHash,
              startTick: 0,
              durationTicks: videoStream.value.durationTicks,
              timeBase: videoStream.value.timeBase,
            },
          },
          speed: { numerator: 2, denominator: 1 },
          reverse: true,
          audioPolicy: 'preserve-pitch',
          transform: {
            fit: 'fit',
            positionX: 12,
            positionY: -8,
            scaleX: 0.9,
            scaleY: 0.9,
            anchorX: 0.5,
            anchorY: 0.5,
            rotationDegrees: 3,
            cropTop: 0.02,
            cropRight: 0.02,
            cropBottom: 0.02,
            cropLeft: 0.02,
            opacity: 0.92,
            blendMode: 'normal',
          },
        },
      }, {
        kind: 'upsert-caption-cue',
        cue: {
          cueId: uuidv7(),
          trackId: captionTrack.trackId,
          timelineStartFrame: 0,
          durationFrames: 30,
          text: 'Canonical export',
          styleId: 'clean',
        },
      }],
    }
    const preview = engine.edits.preview(intent)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const committed = await engine.edits.commit(intent, preview.value.previewHash)
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    const insertedClip = engine.sequences.getPrimary().clips[0]
    expect(insertedClip).toBeTruthy()
    if (!insertedClip) return
    const splitIntent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId: sequence.sequenceId,
      baseRevision: engine.head,
      actor: 'export-render-test',
      sourceSurface: 'ui',
      confirmationPolicy: 'reversible-single-step',
      operations: [{
        kind: 'split-clip',
        clipId: insertedClip.clipId,
        splitFrame: 15,
      }],
    }
    const splitPreview = engine.edits.preview(splitIntent)
    expect(splitPreview.ok).toBe(true)
    if (!splitPreview.ok) return
    const splitCommit = await engine.edits.commit(
      splitIntent,
      splitPreview.value.previewHash,
    )
    expect(splitCommit.ok).toBe(true)
    if (!splitCommit.ok) return
    const splitClips = engine.sequences.getPrimary().clips.sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame)
    expect(splitClips).toHaveLength(2)
    const transitionIntent: EditIntent = {
      intentVersion: MVP_CONTRACT_VERSION,
      commandId: uuidv7(),
      sequenceId: sequence.sequenceId,
      baseRevision: engine.head,
      actor: 'export-render-test',
      sourceSurface: 'ui',
      confirmationPolicy: 'reversible-single-step',
      operations: [{
        kind: 'set-transition',
        outgoingClipId: splitClips[0]!.clipId,
        incomingClipId: splitClips[1]!.clipId,
        transition: {
          transitionId: uuidv7(),
          trackId: track.trackId,
          outgoingClipId: splitClips[0]!.clipId,
          incomingClipId: splitClips[1]!.clipId,
          kind: 'dissolve',
          durationFrames: 6,
          alignment: 'center',
        },
      }],
    }
    const transitionPreview = engine.edits.preview(transitionIntent)
    expect(transitionPreview.ok).toBe(true)
    if (!transitionPreview.ok) return
    const transitionCommit = await engine.edits.commit(
      transitionIntent,
      transitionPreview.value.previewHash,
    )
    expect(transitionCommit.ok).toBe(true)
    if (!transitionCommit.ok) return
    const sequenceRevision = transitionCommit.value.revision
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Network disabled')
    }))
    registerExportSequenceJob(engine)
    await setEngineRoot(rootDir, engine)
    const result = await queue.enqueueAndWait<{
      success: boolean
      artifactId: string
      output: string
      outputObjectHash: string
    }>('canonical-export-render', {
      type: 'export_sequence',
      bookId: engine.book.get().bookId,
      sequenceRevision: engine.head,
      orientation: 'square',
      captions: 'omit',
    }, 60_000)
    expect(result).toMatchObject({
      success: true,
      output: 'original.mp4',
    })
    const outputManifest = await engine.files.manifest(result.artifactId)
    expect(outputManifest.ok).toBe(true)
    if (!outputManifest.ok) return
    const output = outputManifest.value.files.find((file) =>
      file.name === result.output)
    expect(output?.objectHash).toBe(result.outputObjectHash)
    const outputProbe = await probeVideo(join(outputManifest.value.path, result.output))
    expect(outputProbe).toMatchObject({
      width: 1080,
      height: 1080,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    })
    const outputStreams = engine.streams.list(result.artifactId)
    expect(outputStreams.ok).toBe(true)
    if (outputStreams.ok) {
      expect(outputStreams.value.map((stream) => stream.kind).sort()).toEqual([
        'audio',
        'video',
      ])
    }
    const metadata = await engine.metadata.artifacts.read<{
      sequenceRevision: string
      inputObjectHashes: string[]
      outputObjectHash: string
    }>(result.artifactId, 'export')
    expect(metadata.ok).toBe(true)
    if (metadata.ok) {
      expect(metadata.value).toMatchObject({
        sequenceRevision,
        inputObjectHashes: [objectHash],
        outputObjectHash: result.outputObjectHash,
      })
    }
    const sidecarResult = await queue.enqueueAndWait<{
      artifactId: string
      output: string
    }>('canonical-export-sidecar', {
      type: 'export_sequence',
      bookId: engine.book.get().bookId,
      sequenceRevision: engine.head,
      orientation: 'square',
      captions: 'sidecar',
    }, 60_000)
    const sidecarManifest = await engine.files.manifest(sidecarResult.artifactId)
    expect(sidecarManifest.ok).toBe(true)
    if (sidecarManifest.ok) {
      expect(sidecarManifest.value.files.map((file) => file.name)).toEqual(
        expect.arrayContaining(['original.mp4', 'captions.vtt']),
      )
    }
    const burnedResult = await queue.enqueueAndWait<{
      artifactId: string
      output: string
    }>('canonical-export-burned', {
      type: 'export_sequence',
      bookId: engine.book.get().bookId,
      sequenceRevision: engine.head,
      orientation: 'square',
      captions: 'burn-in',
    }, 60_000)
    const burnedManifest = await engine.files.manifest(burnedResult.artifactId)
    expect(burnedManifest.ok).toBe(true)
    if (burnedManifest.ok) {
      expect(burnedManifest.value.files.map((file) => file.name)).toContain(
        'original.mp4',
      )
      expect(burnedManifest.value.files.map((file) => file.name)).not.toContain(
        'captions.vtt',
      )
    }
    engine.close()
  }, 90_000)
})

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
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'

function resultJson(result: {
  isError?: true
  content: Array<{ type: 'text'; text: string }>
}): unknown {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed')
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('CommandPlan edit tools', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    }
  })

  it('shares preview, atomic commit, stale review, audit, and forward restore', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-command-plan-'))
    const engine = createEngine({
      rootDir,
      initialBookSlug: 'command-plan',
    })
    const artifact = await engine.artifacts.create('image', 'cover')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from('image-bytes'),
    )).ok).toBe(true)
    expect((await engine.files.write(
      artifact.value.artifactId,
      '.original.analysis.json',
      JSON.stringify({ subjectPlacement: 'right' }),
    )).ok).toBe(true)
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files.find((file) =>
      file.name === 'original.png')?.objectHash
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
      actor: 'parity-fixture',
      sourceSurface: 'slash',
      confirmationPolicy: 'reversible-single-step',
      operations: [{
        kind: 'insert-clip',
        mode: 'insert',
        placement: {
          trackId: videoTrack.trackId,
          timelineStartFrame: 0,
          durationFrames: 90,
          source: {
            kind: 'still',
            artifactId: artifact.value.artifactId,
            sourcePath: 'original.png',
            objectHash,
          },
        },
      }],
    }
    const tools = new Map(commandPlanDefs(engine).map((tool) => [tool.name, tool]))
    const preview = resultJson(await tools.get('preview_edit_intent')!.handler({
      book_id: engine.book.get().bookId,
      intent,
    })) as { valid: boolean; previewHash: string }
    expect(preview.valid).toBe(true)
    const commit = resultJson(await tools.get('commit_edit_intent')!.handler({
      book_id: engine.book.get().bookId,
      intent,
      preview_hash: preview.previewHash,
    })) as { actionId: string; revision: string }
    expect(engine.sequences.getPrimary().clips).toHaveLength(1)
    const staleIntent: EditIntent = {
      ...intent,
      commandId: uuidv7(),
      operations: [{
        ...intent.operations[0]!,
        placement: {
          ...intent.operations[0]!.placement,
          timelineStartFrame: 90,
        },
      }],
    }
    const stale = resultJson(await tools.get('preview_edit_intent')!.handler({
      book_id: engine.book.get().bookId,
      intent: staleIntent,
    })) as { valid: boolean; conflicts: Array<{ code: string }> }
    expect(stale).toMatchObject({
      valid: false,
      conflicts: expect.arrayContaining([
        expect.objectContaining({ code: 'OVERLAPPING_WRITE' }),
      ]),
    })
    const audit = resultJson(await tools.get('get_edit_action')!.handler({
      book_id: engine.book.get().bookId,
      action_id: commit.actionId,
    })) as { baseRevision: string; committedRevision: string }
    expect(audit.committedRevision).toBe(commit.revision)
    const restored = resultJson(await tools.get('restore_edit_action')!.handler({
      book_id: engine.book.get().bookId,
      target_revision: audit.baseRevision,
      base_revision: engine.head,
      actor: 'parity-fixture',
      source_surface: 'ui',
    })) as { revision: string; sequence: { clips: unknown[] } }
    expect(restored.revision).not.toBe(commit.revision)
    expect(restored.sequence.clips).toEqual([])
    const insertPlans = await Promise.all(
      (['ui', 'slash', 'chat'] as const).map(async (sourceSurface) =>
        resultJson(await tools.get('plan_sequence_edit')!.handler({
          book_id: engine.book.get().bookId,
          source_surface: sourceSurface,
          actor: 'parity-fixture',
          request: {
            kind: 'insert',
            artifact_id: artifact.value.artifactId,
            timeline_start_frame: 0,
            duration_frames: 90,
          },
        })) as {
          stages: Array<{ intent: EditIntent }>
        }),
    )
    expect(insertPlans.map((plan) => plan.stages[0]!.intent.operations)).toEqual([
      insertPlans[0]!.stages[0]!.intent.operations,
      insertPlans[0]!.stages[0]!.intent.operations,
      insertPlans[0]!.stages[0]!.intent.operations,
    ])
    const plannedInsert = insertPlans[0]!.stages[0]!.intent
    const plannedPreview = resultJson(
      await tools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: plannedInsert,
      }),
    ) as { previewHash: string }
    const plannedCommit = resultJson(
      await tools.get('commit_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: plannedInsert,
        preview_hash: plannedPreview.previewHash,
      }),
    ) as { sequence: { clips: Array<{ clipId: string }> } }
    const imageClipId = plannedCommit.sequence.clips[0]?.clipId
    expect(imageClipId).toBeTruthy()
    if (!imageClipId) return
    const trimPlans = await Promise.all(
      (['ui', 'slash', 'chat'] as const).map(async (sourceSurface) =>
        resultJson(await tools.get('plan_sequence_edit')!.handler({
          book_id: engine.book.get().bookId,
          source_surface: sourceSurface,
          actor: 'parity-fixture',
          request: {
            kind: 'trim',
            clip_id: imageClipId,
            timeline_start_frame: 15,
            duration_frames: 60,
          },
        })) as { stages: Array<{ intent: EditIntent }> }),
    )
    expect(trimPlans.map((plan) => plan.stages[0]!.intent.operations)).toEqual([
      trimPlans[0]!.stages[0]!.intent.operations,
      trimPlans[0]!.stages[0]!.intent.operations,
      trimPlans[0]!.stages[0]!.intent.operations,
    ])
    const audio = await engine.artifacts.create('audio', 'narration')
    expect(audio.ok).toBe(true)
    if (!audio.ok) return
    expect((await engine.files.write(
      audio.value.artifactId,
      'original.wav',
      Buffer.from('audio-bytes'),
    )).ok).toBe(true)
    const audioFiles = await engine.files.manifest(audio.value.artifactId)
    expect(audioFiles.ok).toBe(true)
    if (!audioFiles.ok) return
    const audioHash = audioFiles.value.files[0]?.objectHash
    expect(audioHash).toBeTruthy()
    if (!audioHash) return
    const audioStream = await engine.streams.register({
      artifactId: audio.value.artifactId,
      sourcePath: 'original.wav',
      objectHash: audioHash,
      streamIndex: 0,
      kind: 'audio',
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 96_000,
      codec: 'pcm_s16le',
      audio: {
        sampleRateHz: 48_000,
        channels: 1,
        channelLayout: 'mono',
      },
    })
    expect(audioStream.ok).toBe(true)
    const audioPlan = resultJson(
      await tools.get('plan_sequence_edit')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'ui',
        actor: 'parity-fixture',
        request: {
          kind: 'insert',
          artifact_id: audio.value.artifactId,
          timeline_start_frame: 0,
        },
      }),
    ) as { stages: Array<{ intent: EditIntent }> }
    const audioIntent = audioPlan.stages[0]!.intent
    const audioPreview = resultJson(
      await tools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: audioIntent,
      }),
    ) as { previewHash: string }
    const audioCommit = resultJson(
      await tools.get('commit_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: audioIntent,
        preview_hash: audioPreview.previewHash,
      }),
    ) as { sequence: { clips: Array<{ clipId: string; source: { artifactId: string } }> } }
    const audioClipId = audioCommit.sequence.clips.find((clip) =>
      clip.source.artifactId === audio.value.artifactId)?.clipId
    expect(audioClipId).toBeTruthy()
    if (!audioClipId) return
    const secondAudioTrack = engine.sequences.getPrimary().tracks.find((track) =>
      track.kind === 'audio'
      && track.trackId !== engine.sequences.getPrimary().clips.find((clip) =>
        clip.clipId === audioClipId)?.trackId)
    expect(secondAudioTrack).toBeTruthy()
    if (!secondAudioTrack) return
    const musicPlan = resultJson(
      await tools.get('plan_sequence_edit')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'ui',
        actor: 'parity-fixture',
        request: {
          kind: 'insert',
          artifact_id: audio.value.artifactId,
          track_id: secondAudioTrack.trackId,
          timeline_start_frame: 0,
        },
      }),
    ) as { stages: Array<{ intent: EditIntent }> }
    const musicPreview = resultJson(
      await tools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: musicPlan.stages[0]!.intent,
      }),
    ) as { previewHash: string }
    const musicCommit = resultJson(
      await tools.get('commit_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: musicPlan.stages[0]!.intent,
        preview_hash: musicPreview.previewHash,
      }),
    ) as { sequence: { clips: Array<{ clipId: string; trackId: string }> } }
    const musicClipId = musicCommit.sequence.clips.find((clip) =>
      clip.trackId === secondAudioTrack.trackId)?.clipId
    expect(musicClipId).toBeTruthy()
    if (!musicClipId) return
    const volumePlans = await Promise.all(
      (['ui', 'slash', 'chat'] as const).map(async (sourceSurface) =>
        resultJson(await tools.get('plan_sequence_edit')!.handler({
          book_id: engine.book.get().bookId,
          source_surface: sourceSurface,
          actor: 'parity-fixture',
          request: {
            kind: 'volume',
            clip_id: audioClipId,
            gain_db: -6,
            fade_in_frames: 12,
            fade_out_frames: 18,
          },
        })) as { stages: Array<{ intent: EditIntent }> }),
    )
    expect(volumePlans.map((plan) => plan.stages[0]!.intent.operations)).toEqual([
      volumePlans[0]!.stages[0]!.intent.operations,
      volumePlans[0]!.stages[0]!.intent.operations,
      volumePlans[0]!.stages[0]!.intent.operations,
    ])
    const duckPlans = await Promise.all(
      (['ui', 'slash', 'chat'] as const).map(async (sourceSurface) =>
        resultJson(await tools.get('plan_sequence_edit')!.handler({
          book_id: engine.book.get().bookId,
          source_surface: sourceSurface,
          actor: 'parity-fixture',
          request: {
            kind: 'duck',
            narration_clip_id: audioClipId,
            reduction_db: -12,
          },
        })) as { stages: Array<{ intent: EditIntent }> }),
    )
    expect(duckPlans.map((plan) => plan.stages[0]!.intent.operations)).toEqual([
      duckPlans[0]!.stages[0]!.intent.operations,
      duckPlans[0]!.stages[0]!.intent.operations,
      duckPlans[0]!.stages[0]!.intent.operations,
    ])
    expect(duckPlans[0]!.stages[0]!.intent.operations).toEqual([
      expect.objectContaining({
        kind: 'set-clip-audio',
        clipId: musicClipId,
        audio: expect.objectContaining({ gainDb: -12 }),
      }),
    ])
    const chatPlan = resultJson(
      await tools.get('plan_chat_command')!.handler({
        book_id: engine.book.get().bookId,
        actor: 'parity-fixture',
        prompt: `trim clip ${imageClipId.slice(0, 10)} from frame 15 for 60 frames then set volume clip ${audioClipId.slice(0, 10)} to -6 dB`,
      }),
    ) as {
      sourceSurface: string
      confirmation: { required: boolean }
      stages: Array<{ intent: EditIntent }>
    }
    expect(chatPlan.sourceSurface).toBe('chat')
    expect(chatPlan.confirmation.required).toBe(true)
    expect(chatPlan.stages[0]!.intent.operations).toEqual([
      trimPlans[0]!.stages[0]!.intent.operations[0],
      expect.objectContaining({
        kind: 'set-clip-audio',
        clipId: audioClipId,
        audio: expect.objectContaining({ gainDb: -6 }),
      }),
    ])
    const clarification = resultJson(
      await tools.get('plan_chat_command')!.handler({
        book_id: engine.book.get().bookId,
        actor: 'parity-fixture',
        prompt: 'make this amazing',
      }),
    ) as { kind: string; message: string }
    expect(clarification).toMatchObject({
      kind: 'clarification',
      reason: 'unsupported',
      message: expect.stringContaining('ducking, captions'),
    })
    const generationPlan = resultJson(
      await tools.get('plan_generation_insert')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'ui',
        actor: 'parity-fixture',
        generation: {
          tool: 'generate_kie_grok_imagine_text_to_video',
          input: { prompt: 'A quiet skyline' },
          provider: 'kie',
          model: 'grok-imagine-video',
          estimated_cost_usd: 0.12,
          track_id: videoTrack.trackId,
          timeline_start_frame: 120,
          duration_frames: 90,
        },
      }),
    ) as {
      planId: string
      confirmation: { required: boolean }
      stages: Array<{
        provider: string
        model: string
        estimatedCostUsd: number
        continuation: { baseRevision: string }
      }>
    }
    expect(generationPlan).toMatchObject({
      confirmation: { required: true },
      stages: [{
        provider: 'kie',
        model: 'grok-imagine-video',
        estimatedCostUsd: 0.12,
        continuation: { baseRevision: expect.any(String) },
      }],
    })
    const continued = resultJson(
      await tools.get('continue_queued_insert')!.handler({
        book_id: engine.book.get().bookId,
        plan: generationPlan,
        output_artifact_id: artifact.value.artifactId,
        actor: 'parity-fixture',
      }),
    ) as {
      parentActionId: string
      sourceSurface: string
      stages: Array<{ intent: EditIntent }>
    }
    expect(continued.parentActionId).toBe(generationPlan.planId)
    expect(continued.sourceSurface).toBe('system')
    expect(continued.stages[0]!.intent.operations[0]).toMatchObject({
      kind: 'insert-clip',
      placement: { timelineStartFrame: 120, durationFrames: 90 },
    })
    const staleGenerationPlan = resultJson(
      await tools.get('plan_generation_insert')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'chat',
        actor: 'parity-fixture',
        generation: {
          tool: 'generate_kie_grok_imagine_text_to_video',
          input: { prompt: 'A second skyline' },
          provider: 'kie',
          model: 'grok-imagine-video',
          estimate_unavailable: true,
          track_id: videoTrack.trackId,
          timeline_start_frame: 240,
        },
      }),
    ) as Record<string, unknown>
    const volumeIntent = volumePlans[0]!.stages[0]!.intent
    const volumePreview = resultJson(
      await tools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: volumeIntent,
      }),
    ) as { previewHash: string }
    resultJson(await tools.get('commit_edit_intent')!.handler({
      book_id: engine.book.get().bookId,
      intent: volumeIntent,
      preview_hash: volumePreview.previewHash,
    }))
    const staleContinuation = resultJson(
      await tools.get('continue_queued_insert')!.handler({
        book_id: engine.book.get().bookId,
        plan: staleGenerationPlan,
        output_artifact_id: artifact.value.artifactId,
        actor: 'parity-fixture',
      }),
    ) as { kind: string; outputArtifactId: string }
    expect(staleContinuation).toEqual(expect.objectContaining({
      kind: 'stale-continuation',
      outputArtifactId: artifact.value.artifactId,
    }))
    const adjacentPlan = resultJson(
      await tools.get('plan_sequence_edit')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'ui',
        actor: 'parity-fixture',
        request: {
          kind: 'insert',
          artifact_id: artifact.value.artifactId,
          timeline_start_frame: 90,
          duration_frames: 90,
        },
      }),
    ) as { stages: Array<{ intent: EditIntent }> }
    const adjacentIntent = adjacentPlan.stages[0]!.intent
    const adjacentPreview = resultJson(
      await tools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: adjacentIntent,
      }),
    ) as { previewHash: string }
    resultJson(await tools.get('commit_edit_intent')!.handler({
      book_id: engine.book.get().bookId,
      intent: adjacentIntent,
      preview_hash: adjacentPreview.previewHash,
    }))
    const current = engine.sequences.getPrimary()
    const imageClips = current.clips
      .filter((clip) => clip.source.artifactId === artifact.value.artifactId)
      .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
    const secondVideoTrack = current.tracks.find((track) =>
      track.kind === 'video' && track.trackId !== imageClips[0]?.trackId)
    expect(imageClips).toHaveLength(2)
    expect(secondVideoTrack).toBeTruthy()
    if (imageClips.length !== 2 || !secondVideoTrack) return
    const editCases = [
      {
        request: {
          kind: 'insert',
          artifact_id: artifact.value.artifactId,
          timeline_start_frame: 0,
          duration_frames: 30,
          mode: 'overwrite',
        },
        operation: 'insert-clip',
      },
      {
        request: {
          kind: 'move',
          clip_id: imageClips[1]!.clipId,
          track_id: secondVideoTrack.trackId,
          timeline_start_frame: 0,
        },
        operation: 'move-clip',
      },
      {
        request: {
          kind: 'split',
          clip_id: imageClips[0]!.clipId,
          split_frame: 45,
        },
        operation: 'split-clip',
      },
      {
        request: {
          kind: 'delete',
          clip_id: imageClips[0]!.clipId,
          ripple: true,
        },
        operation: 'remove-range',
      },
      {
        request: {
          kind: 'gap',
          timeline_start_frame: 0,
          duration_frames: 30,
          track_ids: [imageClips[0]!.trackId],
        },
        operation: 'move-clip',
      },
      {
        request: {
          kind: 'transform',
          clip_id: imageClips[0]!.clipId,
          fit: 'fit',
          scale_x: 0.8,
          scale_y: 0.8,
          opacity: 0.9,
        },
        operation: 'set-clip-transform',
      },
      {
        request: {
          kind: 'reframe',
          clip_id: imageClips[0]!.clipId,
        },
        operation: 'set-clip-transform',
      },
      {
        request: {
          kind: 'transition',
          outgoing_clip_id: imageClips[0]!.clipId,
          incoming_clip_id: imageClips[1]!.clipId,
          transition_kind: 'dissolve',
          duration_frames: 12,
        },
        operation: 'set-transition',
      },
      {
        request: {
          kind: 'caption',
          timeline_start_frame: 15,
          duration_frames: 60,
          text: 'A shared caption',
          style_id: 'bold',
        },
        operation: 'upsert-caption-cue',
      },
    ] as const
    for (const editCase of editCases) {
      const plan = resultJson(
        await tools.get('plan_sequence_edit')!.handler({
          book_id: engine.book.get().bookId,
          source_surface: 'ui',
          actor: 'parity-fixture',
          request: editCase.request,
        }),
      ) as { stages: Array<{ intent: EditIntent }> }
      expect(plan.stages[0]!.intent.operations[0]?.kind).toBe(editCase.operation)
      if (editCase.request.kind === 'reframe') {
        expect(plan.stages[0]!.intent.operations[0]).toMatchObject({
          kind: 'set-clip-transform',
          transform: {
            fit: 'fill',
            positionX: -engine.sequences.getPrimary().width * 0.18,
          },
        })
      }
      const preview = resultJson(
        await tools.get('preview_edit_intent')!.handler({
          book_id: engine.book.get().bookId,
          intent: plan.stages[0]!.intent,
        }),
      ) as { valid: boolean }
      expect(preview.valid).toBe(true)
    }
    const chatCases = [
      {
        prompt: `move clip ${imageClips[1]!.clipId} to track ${secondVideoTrack.trackId} at frame 0`,
        operation: 'move-clip',
      },
      {
        prompt: `split clip ${imageClips[0]!.clipId.slice(0, 10)} at frame 45`,
        operation: 'split-clip',
      },
      {
        prompt: `ripple delete clip ${imageClips[0]!.clipId.slice(0, 10)}`,
        operation: 'remove-range',
      },
      {
        prompt: 'insert a gap at frame 0 for 30 frames',
        operation: 'move-clip',
      },
      {
        prompt: `fit clip ${imageClips[0]!.clipId.slice(0, 10)}`,
        operation: 'set-clip-transform',
      },
      {
        prompt: `reframe clip ${imageClips[0]!.clipId.slice(0, 10)}`,
        operation: 'set-clip-transform',
      },
      {
        prompt: `reverse clip ${audioClipId.slice(0, 10)}`,
        operation: 'set-clip-speed',
      },
      {
        prompt: `dissolve ${imageClips[0]!.clipId.slice(0, 10)} into ${imageClips[1]!.clipId.slice(0, 10)} for 12 frames`,
        operation: 'set-transition',
      },
      {
        prompt: 'caption from frame 15 for 60 frames bold "A shared caption"',
        operation: 'upsert-caption-cue',
      },
      {
        prompt: `duck clip ${audioClipId.slice(0, 10)} by -12 dB`,
        operation: 'set-clip-audio',
      },
    ] as const
    for (const chatCase of chatCases) {
      const plan = resultJson(
        await tools.get('plan_chat_command')!.handler({
          book_id: engine.book.get().bookId,
          actor: 'parity-fixture',
          prompt: chatCase.prompt,
        }),
      ) as { stages: Array<{ intent: EditIntent }> }
      expect(plan, chatCase.prompt).toHaveProperty('stages')
      expect(plan.stages[0]!.intent.operations[0]?.kind).toBe(chatCase.operation)
    }
    engine.close()
  })

  it('uses validated fullscreen media context for implicit chat inserts', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-media-context-'))
    const engine = createEngine({
      rootDir,
      initialBookSlug: 'media-context',
    })
    const artifact = await engine.artifacts.create('image', 'boat')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.write(
      artifact.value.artifactId,
      'original.png',
      Buffer.from('boat-image'),
    )).ok).toBe(true)
    const notebook = await engine.notebooks.create('Main')
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const cell = engine.notebooks.createCell({
      type: 'image',
      slug: 'img-boat',
      slot: { row: 0, column: 0 },
      outputArtifactId: artifact.value.artifactId,
    })
    const written = await engine.notebooks.write({
      ...notebook.value,
      cells: [cell],
      edges: [],
    })
    expect(written.ok).toBe(true)
    const tools = new Map(commandPlanDefs(engine).map((tool) => [tool.name, tool]))
    const plan = resultJson(await tools.get('plan_chat_command')!.handler({
      book_id: engine.book.get().bookId,
      actor: 'fullscreen-user',
      prompt: 'insert this at frame 120 for 48 frames',
      media_context: {
        notebook_id: notebook.value.id,
        cell_id: cell.id,
        artifact_id: artifact.value.artifactId,
      },
    })) as { stages: Array<{ intent: EditIntent }> }

    expect(plan.stages[0]!.intent.operations).toEqual([
      expect.objectContaining({
        kind: 'insert-clip',
        placement: expect.objectContaining({
          timelineStartFrame: 120,
          durationFrames: 48,
          source: expect.objectContaining({
            artifactId: artifact.value.artifactId,
          }),
        }),
      }),
    ])

    const mismatch = await tools.get('plan_chat_command')!.handler({
      book_id: engine.book.get().bookId,
      actor: 'fullscreen-user',
      prompt: 'insert this at frame 120',
      media_context: {
        notebook_id: notebook.value.id,
        cell_id: cell.id,
        artifact_id: uuidv7(),
      },
    })
    expect(mismatch.isError).toBe(true)
    expect(mismatch.content[0]?.text).toContain(
      'Fullscreen media context does not match the cell output',
    )
    engine.close()
  })
})

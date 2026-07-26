import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'

function wavSilence(sampleRate: number, durationSeconds: number): Buffer {
  const dataLength = sampleRate * durationSeconds * 2
  const output = Buffer.alloc(44 + dataLength)
  output.write('RIFF', 0)
  output.writeUInt32LE(36 + dataLength, 4)
  output.write('WAVE', 8)
  output.write('fmt ', 12)
  output.writeUInt32LE(16, 16)
  output.writeUInt16LE(1, 20)
  output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24)
  output.writeUInt32LE(sampleRate * 2, 28)
  output.writeUInt16LE(2, 32)
  output.writeUInt16LE(16, 34)
  output.write('data', 36)
  output.writeUInt32LE(dataLength, 40)
  return output
}

describe('audio notebook spine', () => {
  let rootDir: string | undefined
  let books: BookManager | undefined

  afterEach(async () => {
    await books?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('designates a typed audio spine and returns waveform and transcript', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-audio-spine-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books') })
    await books.ready()
    const created = await books.create('audio-spine')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const selected = books.get(created.value.bookId)
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    const engine = selected.value.engine
    const notebook = engine.notebooks.list()[0]
    expect(notebook).toBeTruthy()
    if (!notebook) return
    const artifact = await engine.artifacts.create('audio', 'field-notes')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.write(
      artifact.value.artifactId,
      'original.wav',
      wavSilence(48_000, 2),
    )).ok).toBe(true)
    const files = await engine.files.manifest(artifact.value.artifactId)
    expect(files.ok).toBe(true)
    if (!files.ok) return
    const objectHash = files.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const sourceBytes = await engine.files.read(
      artifact.value.artifactId,
      'original.wav',
    )
    expect(sourceBytes.ok).toBe(true)
    if (!sourceBytes.ok) return
    const stream = await engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.wav',
      objectHash,
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
    expect(stream.ok).toBe(true)
    if (!stream.ok) return
    expect((await engine.metadata.waveforms.write(
      artifact.value.artifactId,
      [0.1, 0.8, 0.2],
    )).ok).toBe(true)
    const transcript = await engine.transcripts.import({
      artifactId: artifact.value.artifactId,
      streamId: stream.value.streamId,
      objectHash,
      language: 'en',
      provider: 'fixture',
      segments: [{
        ordinal: 0,
        range: {
          streamId: stream.value.streamId,
          objectHash,
          startTick: 0,
          durationTicks: 48_000,
          timeBase: stream.value.timeBase,
        },
        text: 'The um field note',
        kind: 'speech',
        words: [{
          ordinal: 0,
          startTick: 0,
          durationTicks: 12_000,
          text: 'The',
          corrected: false,
        }, {
          ordinal: 1,
          startTick: 12_000,
          durationTicks: 12_000,
          text: 'um',
          corrected: false,
        }, {
          ordinal: 2,
          startTick: 24_000,
          durationTicks: 12_000,
          text: 'field',
          corrected: false,
        }, {
          ordinal: 3,
          startTick: 36_000,
          durationTicks: 12_000,
          text: 'note',
          corrected: false,
        }],
      }],
    })
    expect(transcript.ok).toBe(true)
    const defs = videobookDomainDefs(engine, books)
    const setSpine = defs.find((tool) => tool.name === 'set_notebook_audio_spine')
    const getSpine = defs.find((tool) => tool.name === 'get_notebook_audio_spine')
    const correctWord = defs.find(
      (tool) => tool.name === 'correct_notebook_transcript_word',
    )
    const checkDuplicate = defs.find((tool) => tool.name === 'check_duplicate_bytes')
    expect(setSpine && getSpine && correctWord && checkDuplicate).toBeTruthy()
    if (!setSpine || !getSpine || !correctWord || !checkDuplicate) return
    const duplicate = await checkDuplicate.handler({
      book_id: created.value.bookId,
      object_hash: objectHash,
    })
    expect(duplicate.isError, duplicate.content[0]?.text).toBeUndefined()
    expect(JSON.parse(duplicate.content[0]!.text)).toMatchObject({
      object_hash: objectHash,
      matches: [{
        artifact_id: artifact.value.artifactId,
        filename: 'original.wav',
      }],
    })

    const setResult = await setSpine.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      artifact_id: artifact.value.artifactId,
    })
    expect(setResult.isError, setResult.content[0]?.text).toBeUndefined()
    const loaded = engine.notebooks.read(notebook.id)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.value.properties?.audioSpine).toMatchObject({
      artifactId: artifact.value.artifactId,
      streamId: stream.value.streamId,
    })
    expect(loaded.value.cells.map((cell) => cell.type)).toEqual([
      'asset',
      'note',
      'scene',
    ])
    expect(loaded.value.edges).toHaveLength(2)
    const sequence = engine.sequences.getPrimary()
    expect(sequence.clips).toHaveLength(1)
    expect(sequence.clips[0]).toMatchObject({
      timelineStartFrame: 0,
      source: {
        kind: 'timed',
        artifactId: artifact.value.artifactId,
        range: {
          streamId: stream.value.streamId,
          objectHash,
          startTick: 0,
          durationTicks: 96_000,
        },
      },
    })

    const getResult = await getSpine.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
    })
    expect(getResult.isError, getResult.content[0]?.text).toBeUndefined()
    const payload = JSON.parse(getResult.content[0]!.text) as {
      waveform: { peaks: number[] }
      transcript: { transcriptId: string }
    }
    expect(payload.waveform.peaks).toEqual([0.1, 0.8, 0.2])
    expect(payload.transcript.transcriptId).toBe(
      transcript.ok ? transcript.value.transcriptId : '',
    )
    if (!transcript.ok) return
    const planCleanup = defs.find(
      (tool) => tool.name === 'plan_notebook_cleanup',
    )
    expect(planCleanup).toBeTruthy()
    if (!planCleanup) return
    const cleanupResult = await planCleanup.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      source_surface: 'ui',
      actor: 'cleanup-fixture',
    })
    expect(cleanupResult.isError, cleanupResult.content[0]?.text).toBeUndefined()
    const cleanupPlan = JSON.parse(cleanupResult.content[0]!.text) as {
      suggestions: Array<{
        suggestionId: string
        category: string
        included: boolean
        operation: { kind: string; ripple: boolean }
      }>
      stages: Array<{ intent: { operations: Array<{ kind: string }> } }>
    }
    expect(cleanupPlan.suggestions).toEqual([
      expect.objectContaining({
        suggestionId: expect.stringMatching(/^filler:/),
        category: 'filler',
        included: true,
        operation: expect.objectContaining({
          kind: 'remove-range',
          ripple: true,
        }),
      }),
    ])
    expect(cleanupPlan.stages[0]?.intent.operations).toEqual([
      expect.objectContaining({ kind: 'remove-range' }),
    ])
    const sourceWord = transcript.value.segments[0]?.words[0]
    expect(sourceWord).toBeTruthy()
    if (!sourceWord) return
    const correction = await correctWord.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      transcript_id: transcript.value.transcriptId,
      word_id: sourceWord.wordId,
      text: 'A',
    })
    expect(correction.isError, correction.content[0]?.text).toBeUndefined()
    const corrected = JSON.parse(correction.content[0]!.text) as {
      revision: string
      segments: Array<{
        words: Array<{
          text: string
          startTick: number
          durationTicks: number
          corrected: boolean
        }>
      }>
    }
    expect(corrected.revision).not.toBe(transcript.value.revision)
    expect(corrected.segments[0]?.words[0]).toMatchObject({
      text: 'A',
      startTick: sourceWord.startTick,
      durationTicks: sourceWord.durationTicks,
      corrected: true,
    })
    const correctedTranscriptId = JSON.parse(correction.content[0]!.text) as {
      transcriptId: string
      segments: Array<{ words: Array<{ wordId: string }> }>
    }
    const selectWords = defs.find(
      (tool) => tool.name === 'select_notebook_transcript_words',
    )
    const removeWords = defs.find(
      (tool) => tool.name === 'remove_notebook_transcript_words',
    )
    const restoreEdit = defs.find(
      (tool) => tool.name === 'restore_notebook_transcript_edit',
    )
    const moveWords = defs.find(
      (tool) => tool.name === 'move_notebook_transcript_words',
    )
    const selectTimeline = defs.find(
      (tool) => tool.name === 'select_notebook_timeline_range',
    )
    expect(
      selectWords && removeWords && restoreEdit && moveWords && selectTimeline,
    ).toBeTruthy()
    if (
      !selectWords
      || !removeWords
      || !restoreEdit
      || !moveWords
      || !selectTimeline
    ) return
    const correctedWordId = correctedTranscriptId.segments[0]?.words[0]?.wordId
    expect(correctedWordId).toBeTruthy()
    if (!correctedWordId) return
    const selection = await selectWords.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      transcript_id: correctedTranscriptId.transcriptId,
      start_word_id: correctedWordId,
      end_word_id: correctedWordId,
    })
    expect(selection.isError, selection.content[0]?.text).toBeUndefined()
    const selectedNotebook = engine.notebooks.read(notebook.id)
    expect(selectedNotebook.ok).toBe(true)
    if (!selectedNotebook.ok) return
    expect(selectedNotebook.value.cells.map((cell) => cell.type)).toEqual([
      'asset',
      'note',
      'scene',
      'selects',
    ])
    expect(selectedNotebook.value.edges).toHaveLength(3)
    expect(selectedNotebook.value.properties?.currentSelection).toMatchObject({
      transcriptId: correctedTranscriptId.transcriptId,
      startWordId: correctedWordId,
      endWordId: correctedWordId,
      sequence: {
        sequenceId: sequence.sequenceId,
        clipId: sequence.clips[0]?.clipId,
        range: {
          sequenceId: sequence.sequenceId,
          startFrame: 0,
          durationFrames: 8,
        },
      },
    })
    const removalPreview = await removeWords.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      transcript_id: correctedTranscriptId.transcriptId,
      start_word_id: correctedWordId,
      end_word_id: correctedWordId,
    })
    expect(removalPreview.isError, removalPreview.content[0]?.text).toBeUndefined()
    const pendingRemoval = JSON.parse(removalPreview.content[0]!.text) as {
      confirmationRequired: boolean
      commandId: string
      baseRevision: string
      preview: { previewHash: string }
    }
    expect(pendingRemoval.confirmationRequired).toBe(true)
    const removal = await removeWords.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      transcript_id: correctedTranscriptId.transcriptId,
      start_word_id: correctedWordId,
      end_word_id: correctedWordId,
      command_id: pendingRemoval.commandId,
      base_revision: pendingRemoval.baseRevision,
      preview_hash: pendingRemoval.preview.previewHash,
    })
    expect(removal.isError, removal.content[0]?.text).toBeUndefined()
    const committedRemoval = JSON.parse(removal.content[0]!.text) as {
      commit: {
        actionId: string
        sequence: { clips: Array<{ durationFrames: number }> }
      }
    }
    expect(committedRemoval.commit.sequence.clips).toHaveLength(1)
    expect(committedRemoval.commit.sequence.clips[0]?.durationFrames).toBe(52)
    const restorePreview = await restoreEdit.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      action_id: committedRemoval.commit.actionId,
    })
    expect(restorePreview.isError, restorePreview.content[0]?.text).toBeUndefined()
    expect(JSON.parse(restorePreview.content[0]!.text)).toMatchObject({
      confirmationRequired: true,
      actionId: committedRemoval.commit.actionId,
    })
    const restored = await restoreEdit.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      action_id: committedRemoval.commit.actionId,
      confirm: true,
    })
    expect(restored.isError, restored.content[0]?.text).toBeUndefined()
    const restoredPayload = JSON.parse(restored.content[0]!.text) as {
      restore: { sequence: { clips: Array<{ durationFrames: number }> } }
    }
    expect(restoredPayload.restore.sequence.clips).toHaveLength(1)
    expect(restoredPayload.restore.sequence.clips[0]?.durationFrames).toBe(60)
    const destinationWordId = correctedTranscriptId.segments[0]?.words[3]?.wordId
    expect(destinationWordId).toBeTruthy()
    if (!destinationWordId) return
    const movePreview = await moveWords.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      transcript_id: correctedTranscriptId.transcriptId,
      start_word_id: correctedWordId,
      end_word_id: correctedWordId,
      before_word_id: destinationWordId,
    })
    expect(movePreview.isError, movePreview.content[0]?.text).toBeUndefined()
    const pendingMove = JSON.parse(movePreview.content[0]!.text) as {
      confirmationRequired: boolean
      commandId: string
      baseRevision: string
      preview: { previewHash: string }
    }
    expect(pendingMove.confirmationRequired).toBe(true)
    const moved = await moveWords.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      transcript_id: correctedTranscriptId.transcriptId,
      start_word_id: correctedWordId,
      end_word_id: correctedWordId,
      before_word_id: destinationWordId,
      command_id: pendingMove.commandId,
      base_revision: pendingMove.baseRevision,
      preview_hash: pendingMove.preview.previewHash,
    })
    expect(moved.isError, moved.content[0]?.text).toBeUndefined()
    const movedPayload = JSON.parse(moved.content[0]!.text) as {
      commit: {
        actionId: string
        sequence: {
          clips: Array<{
            timelineStartFrame: number
            durationFrames: number
            source: { range: { startTick: number; durationTicks: number } }
          }>
          captions: Array<{ text: string; timelineStartFrame: number }>
        }
      }
    }
    expect(movedPayload.commit.sequence.clips).toEqual([
      expect.objectContaining({
        timelineStartFrame: 0,
        durationFrames: 14,
        source: expect.objectContaining({
          range: expect.objectContaining({ startTick: 12_800 }),
        }),
      }),
      expect.objectContaining({
        timelineStartFrame: 14,
        durationFrames: 8,
        source: expect.objectContaining({
          range: expect.objectContaining({
            startTick: 0,
            durationTicks: 12_000,
          }),
        }),
      }),
      expect.objectContaining({
        timelineStartFrame: 22,
        source: expect.objectContaining({
          range: expect.objectContaining({ startTick: 35_200 }),
        }),
      }),
    ])
    expect(movedPayload.commit.sequence.captions).toEqual([
      expect.objectContaining({
        text: 'A',
        timelineStartFrame: 14,
      }),
    ])
    const timelineSelection = await selectTimeline.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      start_frame: 14,
      duration_frames: 8,
    })
    expect(
      timelineSelection.isError,
      timelineSelection.content[0]?.text,
    ).toBeUndefined()
    expect(JSON.parse(timelineSelection.content[0]!.text)).toMatchObject({
      transcriptId: correctedTranscriptId.transcriptId,
      startWordId: correctedWordId,
      endWordId: correctedWordId,
      sequence: {
        range: {
          sequenceId: sequence.sequenceId,
          startFrame: 14,
          durationFrames: 8,
        },
      },
    })
    const planCaptions = defs.find(
      (tool) => tool.name === 'plan_notebook_captions',
    )
    expect(planCaptions).toBeTruthy()
    if (!planCaptions) return
    const captionPlanResult = await planCaptions.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      source_surface: 'ui',
      actor: 'caption-fixture',
      style_id: 'high-contrast',
    })
    expect(
      captionPlanResult.isError,
      captionPlanResult.content[0]?.text,
    ).toBeUndefined()
    const captionPlan = JSON.parse(captionPlanResult.content[0]!.text) as {
      confirmation: { required: boolean }
      stages: Array<{ intent: {
        operations: Array<{
          kind: string
          cue?: {
            text: string
            styleId: string
            transcriptSelection?: {
              transcriptId: string
              startWordId: string
              endWordId: string
            }
          }
        }>
      } }>
    }
    expect(captionPlan.confirmation.required).toBe(true)
    expect(captionPlan.stages[0]!.intent.operations[0]?.kind).toBe(
      'remove-range',
    )
    const captionUpserts = captionPlan.stages[0]!.intent.operations.slice(1)
    expect(captionUpserts.length).toBeGreaterThan(0)
    expect(captionUpserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'upsert-caption-cue',
        cue: expect.objectContaining({
          styleId: 'high-contrast',
          transcriptSelection: expect.objectContaining({
            transcriptId: correctedTranscriptId.transcriptId,
          }),
        }),
      }),
    ]))
    const captionIntent = captionPlan.stages[0]!.intent
    const commandTools = new Map(
      commandPlanDefs(engine).map((tool) => [tool.name, tool]),
    )
    const captionPreviewResult = await commandTools
      .get('preview_edit_intent')!
      .handler({
        book_id: created.value.bookId,
        intent: captionIntent,
      })
    expect(
      captionPreviewResult.isError,
      captionPreviewResult.content[0]?.text,
    ).toBeUndefined()
    const captionPreview = JSON.parse(
      captionPreviewResult.content[0]!.text,
    ) as { valid: boolean; previewHash: string }
    expect(captionPreview.valid).toBe(true)
    const captionCommitResult = await commandTools
      .get('commit_edit_intent')!
      .handler({
        book_id: created.value.bookId,
        intent: captionIntent,
        preview_hash: captionPreview.previewHash,
      })
    expect(
      captionCommitResult.isError,
      captionCommitResult.content[0]?.text,
    ).toBeUndefined()
    expect(engine.sequences.getPrimary().captions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          styleId: 'high-contrast',
          transcriptSelection: expect.objectContaining({
            transcriptId: correctedTranscriptId.transcriptId,
          }),
        }),
      ]),
    )
    const reloadedNotebook = engine.notebooks.read(notebook.id)
    expect(reloadedNotebook.ok).toBe(true)
    if (!reloadedNotebook.ok) return
    expect(reloadedNotebook.value.properties?.transcriptEdits).toEqual([
      expect.objectContaining({
        kind: 'remove',
        actionId: committedRemoval.commit.actionId,
        restored: true,
        restoreActionId: expect.any(String),
      }),
      expect.objectContaining({
        kind: 'move',
        actionId: movedPayload.commit.actionId,
        beforeWordId: destinationWordId,
        restored: false,
      }),
    ])
    const unchangedSource = await engine.files.read(
      artifact.value.artifactId,
      'original.wav',
    )
    expect(unchangedSource.ok).toBe(true)
    if (!unchangedSource.ok) return
    expect(unchangedSource.value).toEqual(sourceBytes.value)
    const sequenceMix = await engine.artifacts.create('final', 'sequence-mix')
    expect(sequenceMix.ok).toBe(true)
    if (!sequenceMix.ok) return
    expect((await engine.files.write(
      sequenceMix.value.artifactId,
      'original.wav',
      wavSilence(48_000, 2),
    )).ok).toBe(true)
    const mixFiles = await engine.files.manifest(sequenceMix.value.artifactId)
    expect(mixFiles.ok).toBe(true)
    if (!mixFiles.ok) return
    const mixHash = mixFiles.value.files[0]?.objectHash
    expect(mixHash).toBeTruthy()
    if (!mixHash) return
    const mixStream = await engine.streams.register({
      artifactId: sequenceMix.value.artifactId,
      sourcePath: 'original.wav',
      objectHash: mixHash,
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
    expect(mixStream.ok).toBe(true)
    const setMix = await setSpine.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      artifact_id: sequenceMix.value.artifactId,
    })
    expect(setMix.isError, setMix.content[0]?.text).toBeUndefined()
    expect(engine.sequences.getPrimary().clips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: expect.objectContaining({
          artifactId: sequenceMix.value.artifactId,
        }),
      }),
    ]))
  })
})

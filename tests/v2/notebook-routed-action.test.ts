import type { NotebookCell } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import { routedMediaCellInputs } from '../../src/videobook/notebook-routed-action'

const SOURCE_ARTIFACT_ID = '019fabcd-1234-7000-8000-000000000101'
const CLIP_ARTIFACT_ID = '019fabcd-1234-7000-8000-000000000102'
const CHUNK_A_ARTIFACT_ID = '019fabcd-1234-7000-8000-000000000103'
const CHUNK_B_ARTIFACT_ID = '019fabcd-1234-7000-8000-000000000104'
const COVER_ARTIFACT_ID = '019fabcd-1234-7000-8000-000000000105'

const existingCells = [
  {
    id: '019fabcd-1234-7000-8000-000000000001',
    type: 'video',
    label: 'Source video',
    slot: { row: 0, column: 0 },
  },
] as NotebookCell[]

describe('routedMediaCellInputs', () => {
  it('places an extracted clip in the next notebook slot with provenance', () => {
    expect(routedMediaCellInputs('extract_video_clip', {
      source_asset_id: SOURCE_ARTIFACT_ID,
      output_asset_id: CLIP_ARTIFACT_ID,
      output_artifact_id: CLIP_ARTIFACT_ID,
      start_time: 15,
      end_time: 45,
      duration: 30,
      job_id: 'extract-clip-1',
    }, existingCells)).toEqual([{
      type: 'video',
      slot: { row: 0, column: 1 },
      inputs: {
        sourceOperation: 'extract_video_clip',
        source_asset_id: SOURCE_ARTIFACT_ID,
        start_time: 15,
        end_time: 45,
        duration: 30,
        job_id: 'extract-clip-1',
      },
      output_artifact_id: CLIP_ARTIFACT_ID,
    }])
  })

  it('places both split clips and returns no cells for in-place tools', () => {
    expect(routedMediaCellInputs('split_video', {
      source_asset_id: SOURCE_ARTIFACT_ID,
      chunk_a_asset_id: CHUNK_A_ARTIFACT_ID,
      chunk_a_artifact_id: CHUNK_A_ARTIFACT_ID,
      chunk_b_asset_id: CHUNK_B_ARTIFACT_ID,
      chunk_b_artifact_id: CHUNK_B_ARTIFACT_ID,
      chunk_a_end: 15,
      chunk_b_start: 15,
      overlap_sec: 0,
      job_id: 'split-1',
    }, existingCells).map((cell) => ({
      output_artifact_id: cell.output_artifact_id,
      slot: cell.slot,
      splitOutput: cell.inputs.splitOutput,
    }))).toEqual([
      {
        output_artifact_id: CHUNK_A_ARTIFACT_ID,
        slot: { row: 0, column: 1 },
        splitOutput: 'first',
      },
      {
        output_artifact_id: CHUNK_B_ARTIFACT_ID,
        slot: { row: 0, column: 2 },
        splitOutput: 'remaining',
      },
    ])
    expect(routedMediaCellInputs('trim_video', {}, existingCells)).toEqual([])
  })

  it('rejects a routed extraction result that cannot be placed', () => {
    expect(() => routedMediaCellInputs('extract_video_clip', {
      output_asset_id: CLIP_ARTIFACT_ID,
    }, existingCells)).toThrow('did not return an artifact')
  })

  it('places a cover-song audio result beside its source with job provenance', () => {
    expect(routedMediaCellInputs('make_cover_song', {
      audio_asset_id: COVER_ARTIFACT_ID,
      source_asset_id: SOURCE_ARTIFACT_ID,
      source_kind: 'video',
      duration_seconds: 22.01,
      job_id: 'make-cover-song-1',
      status: 'enqueued',
    }, [{
      ...existingCells[0]!,
      outputArtifactId: SOURCE_ARTIFACT_ID,
    }])).toEqual([{
      type: 'audio',
      slot: { row: 0, column: 1 },
      inputs: {
        sourceOperation: 'make_cover_song',
        source_asset_id: SOURCE_ARTIFACT_ID,
        source_kind: 'video',
        duration_seconds: 22.01,
        job_id: 'make-cover-song-1',
      },
      output_artifact_id: COVER_ARTIFACT_ID,
    }])
  })

  it('does not place a routed artifact that is already on the grid', () => {
    expect(routedMediaCellInputs('make_cover_song', {
      audio_asset_id: COVER_ARTIFACT_ID,
      source_asset_id: SOURCE_ARTIFACT_ID,
    }, [{
      ...existingCells[0]!,
      outputArtifactId: COVER_ARTIFACT_ID,
    }])).toEqual([])
  })
})

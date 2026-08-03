import type { NotebookCell } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import { routedVideoCellInputs } from '../../src/videobook/notebook-routed-action'

const existingCells = [
  {
    id: '019fabcd-1234-7000-8000-000000000001',
    type: 'video',
    slug: 'vid-source',
    slot: { row: 0, column: 0 },
  },
] as NotebookCell[]

describe('routedVideoCellInputs', () => {
  it('places an extracted clip in the next notebook slot with provenance', () => {
    expect(routedVideoCellInputs('extract_video_clip', {
      source_asset_id: 'vid-source',
      output_asset_id: 'vid-source-15s-45s',
      output_artifact_id: '019fabcd-1234-7000-8000-000000000002',
      start_time: 15,
      end_time: 45,
      duration: 30,
      job_id: 'extract-clip-1',
    }, existingCells)).toEqual([{
      type: 'video',
      slug: 'vid-source-15s-45s',
      slot: { row: 0, column: 1 },
      inputs: {
        sourceOperation: 'extract_video_clip',
        source_asset_id: 'vid-source',
        start_time: 15,
        end_time: 45,
        duration: 30,
        job_id: 'extract-clip-1',
      },
      output_artifact_id: '019fabcd-1234-7000-8000-000000000002',
    }])
  })

  it('places both split clips and returns no cells for in-place tools', () => {
    expect(routedVideoCellInputs('split_video', {
      source_asset_id: 'vid-source',
      chunk_a_asset_id: 'vid-source-1',
      chunk_a_artifact_id: '019fabcd-1234-7000-8000-000000000002',
      chunk_b_asset_id: 'vid-source-2',
      chunk_b_artifact_id: '019fabcd-1234-7000-8000-000000000003',
      chunk_a_end: 15,
      chunk_b_start: 15,
      overlap_sec: 0,
      job_id: 'split-1',
    }, existingCells).map((cell) => ({
      slug: cell.slug,
      slot: cell.slot,
      splitOutput: cell.inputs.splitOutput,
    }))).toEqual([
      {
        slug: 'vid-source-1',
        slot: { row: 0, column: 1 },
        splitOutput: 'first',
      },
      {
        slug: 'vid-source-2',
        slot: { row: 0, column: 2 },
        splitOutput: 'remaining',
      },
    ])
    expect(routedVideoCellInputs('trim_video', {}, existingCells)).toEqual([])
  })

  it('rejects a routed extraction result that cannot be placed', () => {
    expect(() => routedVideoCellInputs('extract_video_clip', {
      output_asset_id: 'vid-source-15s-45s',
    }, existingCells)).toThrow('did not return an artifact')
  })
})

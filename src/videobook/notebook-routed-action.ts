import type { NotebookCell } from 'videobook-engine'
import { firstEmptyNotebookGridSlots } from 'videobook-engine/notebook-grid'
import { nextNotebookHorizontalGenerationSlot } from './notebook-grid'

export interface RoutedMediaCellInput {
  type: 'audio' | 'video'
  slot: { row: number; column: number }
  inputs: Record<string, unknown>
  output_artifact_id: string
}

interface RoutedMediaOutput {
  artifactId: string
  inputs: Record<string, unknown>
  type: 'audio' | 'video'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function selectedValues(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => value[key] === undefined
    ? []
    : [[key, value[key]]]))
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const result = stringValue(value[key])
  if (!result) throw new Error(message)
  return result
}

function extractOutput(value: Record<string, unknown>): RoutedMediaOutput {
  return {
    type: 'video',
    artifactId: requiredString(
      value,
      'output_artifact_id',
      'The extracted clip did not return an artifact for the notebook',
    ),
    inputs: {
      sourceOperation: 'extract_video_clip',
      ...selectedValues(value, [
        'source_asset_id',
        'start_time',
        'end_time',
        'duration',
        'job_id',
      ]),
    },
  }
}

function splitOutputs(value: Record<string, unknown>): RoutedMediaOutput[] {
  const shared = selectedValues(value, [
    'source_asset_id',
    'chunk_a_end',
    'chunk_b_start',
    'overlap_sec',
    'job_id',
  ])
  return [
    {
      type: 'video',
      artifactId: requiredString(
        value,
        'chunk_a_artifact_id',
        'The first split clip did not return an artifact for the notebook',
      ),
      inputs: {
        sourceOperation: 'split_video',
        splitOutput: 'first',
        ...shared,
      },
    },
    {
      type: 'video',
      artifactId: requiredString(
        value,
        'chunk_b_artifact_id',
        'The remaining split clip did not return an artifact for the notebook',
      ),
      inputs: {
        sourceOperation: 'split_video',
        splitOutput: 'remaining',
        ...shared,
      },
    },
  ]
}

function coverSongOutput(value: Record<string, unknown>): RoutedMediaOutput {
  return {
    type: 'audio',
    artifactId: requiredString(
      value,
      'audio_asset_id',
      'The cover song did not return an audio artifact for the notebook',
    ),
    inputs: {
      sourceOperation: 'make_cover_song',
      ...selectedValues(value, [
        'source_asset_id',
        'source_kind',
        'duration_seconds',
        'job_id',
      ]),
    },
  }
}

function coverSongSlot(
  value: Record<string, unknown>,
  cells: readonly NotebookCell[],
): { row: number; column: number } {
  const sourceArtifactId = stringValue(value.source_asset_id)
  const source = sourceArtifactId
    ? cells.find((cell) => cell.outputArtifactId === sourceArtifactId)
    : undefined
  return nextNotebookHorizontalGenerationSlot(
    cells,
    source ? [source.slot] : [],
  )
}

export function routedMediaCellInputs(
  tool: string,
  result: unknown,
  cells: readonly NotebookCell[],
): RoutedMediaCellInput[] {
  if (
    tool !== 'extract_video_clip'
    && tool !== 'split_video'
    && tool !== 'make_cover_song'
  ) return []
  const value = record(result)
  if (!value) throw new Error(`${tool} returned an invalid result`)
  const outputs = tool === 'extract_video_clip'
    ? [extractOutput(value)]
    : tool === 'split_video'
      ? splitOutputs(value)
      : [coverSongOutput(value)]
  const unplaced = outputs.filter((output) => !cells.some((cell) =>
    cell.outputArtifactId === output.artifactId))
  if (unplaced.length === 0) return []
  const slots = tool === 'make_cover_song'
    ? [coverSongSlot(value, cells)]
    : firstEmptyNotebookGridSlots(
      cells.map((cell) => cell.slot),
      unplaced.length,
    )
  return unplaced.map((output, index) => ({
    type: output.type,
    slot: slots[index]!,
    inputs: output.inputs,
    output_artifact_id: output.artifactId,
  }))
}

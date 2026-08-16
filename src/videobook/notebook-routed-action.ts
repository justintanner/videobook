import type { NotebookCell, NotebookGridSlot } from 'videobook-engine'
import {
  nextNotebookHorizontalGenerationSlot,
  nextNotebookVideoGenerationSlot,
} from './notebook-grid'
import { nonBlankStringValue, recordValue } from './value-decoders'

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
  const result = nonBlankStringValue(value[key])
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
  lastWorkSlot: NotebookGridSlot | null,
): { row: number; column: number } {
  const sourceArtifactId = nonBlankStringValue(value.source_asset_id)
  const source = sourceArtifactId
    ? cells.find((cell) => cell.outputArtifactId === sourceArtifactId)
    : undefined
  return nextNotebookHorizontalGenerationSlot(
    cells,
    source ? [source.slot] : [],
    lastWorkSlot,
  )
}

function videoOutputSlots(
  value: Record<string, unknown>,
  cells: readonly NotebookCell[],
  count: number,
  lastWorkSlot: NotebookGridSlot | null,
): NotebookGridSlot[] {
  const sourceArtifactId = nonBlankStringValue(value.source_asset_id)
  const source = sourceArtifactId
    ? cells.find((cell) => cell.outputArtifactId === sourceArtifactId)
    : undefined
  const sourceSlots = source ? [source.slot] : []
  const working: Array<{ type: string; slot: NotebookGridSlot }> = [...cells]
  const slots: NotebookGridSlot[] = []
  for (let index = 0; index < count; index += 1) {
    const slot = nextNotebookVideoGenerationSlot(
      working,
      sourceSlots,
      lastWorkSlot,
    )
    slots.push(slot)
    working.push({ type: 'video', slot })
  }
  return slots
}

export function routedMediaCellInputs(
  tool: string,
  result: unknown,
  cells: readonly NotebookCell[],
  lastWorkSlot: NotebookGridSlot | null = null,
): RoutedMediaCellInput[] {
  if (
    tool !== 'extract_video_clip'
    && tool !== 'split_video'
    && tool !== 'make_cover_song'
  ) return []
  const value = recordValue(result)
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
    ? [coverSongSlot(value, cells, lastWorkSlot)]
    : videoOutputSlots(value, cells, unplaced.length, lastWorkSlot)
  return unplaced.map((output, index) => ({
    type: output.type,
    slot: slots[index]!,
    inputs: output.inputs,
    output_artifact_id: output.artifactId,
  }))
}

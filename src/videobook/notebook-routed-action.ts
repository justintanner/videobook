import type { NotebookCell } from 'videobook-engine'
import { firstEmptyNotebookGridSlots } from 'videobook-engine/notebook-grid'

export interface RoutedVideoCellInput {
  type: 'video'
  slot: { row: number; column: number }
  inputs: Record<string, unknown>
  output_artifact_id: string
}

interface RoutedVideoOutput {
  artifactId: string
  inputs: Record<string, unknown>
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

function extractOutput(value: Record<string, unknown>): RoutedVideoOutput {
  return {
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

function splitOutputs(value: Record<string, unknown>): RoutedVideoOutput[] {
  const shared = selectedValues(value, [
    'source_asset_id',
    'chunk_a_end',
    'chunk_b_start',
    'overlap_sec',
    'job_id',
  ])
  return [
    {
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

export function routedVideoCellInputs(
  tool: string,
  result: unknown,
  cells: readonly NotebookCell[],
): RoutedVideoCellInput[] {
  if (tool !== 'extract_video_clip' && tool !== 'split_video') return []
  const value = record(result)
  if (!value) throw new Error(`${tool} returned an invalid result`)
  const outputs = tool === 'extract_video_clip'
    ? [extractOutput(value)]
    : splitOutputs(value)
  const slots = firstEmptyNotebookGridSlots(
    cells.map((cell) => cell.slot),
    outputs.length,
  )
  return outputs.map((output, index) => ({
    type: 'video',
    slot: slots[index]!,
    inputs: output.inputs,
    output_artifact_id: output.artifactId,
  }))
}

import type { NotebookCell } from 'videobook-engine'
import { notebookLanePlacement, openNotebookRow, type NotebookLaneCell } from '../../server/src/notebook-lanes.js'
import { isPublishedPostCell } from './notebook-published-post.js'
import { nonBlankStringValue, recordValue } from './value-decoders.js'

interface RoutedMediaCellInput {
  type: 'audio' | 'video'
  slot: { row: number; column: number }
  inputs: Record<string, unknown>
  output_artifact_id: string
}

interface RoutedMediaCellPlacement {
  cell: RoutedMediaCellInput
  makeRoom: boolean
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

function additionalSourceIds(value: Record<string, unknown>): string[] {
  const raw = value.additional_asset_ids ?? value.additional
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const id = nonBlankStringValue(entry)
    return id ? [id] : []
  })
}

function spliceOutput(
  tool: 'smooth_scene_concat' | 'splice_video',
  value: Record<string, unknown>,
): RoutedMediaOutput {
  const firstArtifactId = nonBlankStringValue(value.first_asset_id)
    ?? nonBlankStringValue(value.first)
  const secondArtifactId = nonBlankStringValue(value.second_asset_id)
    ?? nonBlankStringValue(value.second)
  if (!firstArtifactId || !secondArtifactId) {
    throw new Error(`${tool} did not return both source artifacts for the notebook`)
  }
  const additional = additionalSourceIds(value)
  return {
    type: 'video',
    artifactId: requiredString(
      value,
      'asset_id',
      `${tool} did not return an artifact for the notebook`,
    ),
    inputs: {
      sourceOperation: tool,
      first_asset_id: firstArtifactId,
      second_asset_id: secondArtifactId,
      ...(additional.length > 0 ? { additional_asset_ids: additional } : {}),
      ...selectedValues(value, [
        'overlap',
        'transition_seconds',
        'alignment_mode',
        'job_id',
      ]),
    },
  }
}

function placeRoutedOutputs(
  outputs: readonly RoutedMediaOutput[],
  cells: readonly NotebookCell[],
): RoutedMediaCellPlacement[] {
  let working: NotebookLaneCell[] = [...cells]
  return outputs.map((output, index) => {
    const placement = notebookLanePlacement(working, output.type === 'audio' ? 'audio' : 'video')
    if (placement.makeRoom) working = openNotebookRow(working, placement.slot.row)
    working = [...working, {
      id: `routed-output-${index}`,
      type: output.type,
      slot: placement.slot,
      inputs: output.inputs,
    }]
    return {
      cell: {
        type: output.type,
        slot: placement.slot,
        inputs: output.inputs,
        output_artifact_id: output.artifactId,
      },
      makeRoom: placement.makeRoom,
    }
  })
}

export function routedMediaCellInputs(
  tool: string,
  result: unknown,
  cells: readonly NotebookCell[],
): RoutedMediaCellPlacement[] {
  if (
    tool !== 'make_cover_song'
    && tool !== 'splice_video'
    && tool !== 'smooth_scene_concat'
  ) return []
  const value = recordValue(result)
  if (!value) throw new Error(`${tool} returned an invalid result`)
  const outputs = tool === 'make_cover_song'
    ? [coverSongOutput(value)]
    : [spliceOutput(tool, value)]
  const unplaced = outputs.filter((output) => !cells.some((cell) =>
    !isPublishedPostCell(cell) && cell.outputArtifactId === output.artifactId))
  return placeRoutedOutputs(unplaced, cells)
}

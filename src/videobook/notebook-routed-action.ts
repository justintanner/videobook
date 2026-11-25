import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { placeDerivedCell, placeLooseCell } from '../../server/src/notebook-rounds-placement.js'
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

interface RoutedNotebook {
  cells: readonly NotebookCell[]
  edges: readonly NotebookEdge[]
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

function routedSourceArtifactId(output: RoutedMediaOutput): string | null {
  return nonBlankStringValue(output.inputs.source_asset_id) ?? nonBlankStringValue(output.inputs.first_asset_id)
}

function movedAny(before: readonly NotebookCell[], after: readonly NotebookCell[]): boolean {
  return after.some((cell, index) =>
    cell.slot.row !== before[index]?.slot.row || cell.slot.column !== before[index]?.slot.column)
}

function placeRoutedOutputs(
  outputs: readonly RoutedMediaOutput[],
  document: RoutedNotebook,
): RoutedMediaCellPlacement[] {
  let working: NotebookCell[] = [...document.cells]
  return outputs.map((output, index) => {
    const sourceArtifactId = routedSourceArtifactId(output)
    const anchor = sourceArtifactId ? working.find((cell) => cell.outputArtifactId === sourceArtifactId) : undefined
    const placed = anchor
      ? placeDerivedCell({ cells: working, edges: document.edges }, anchor.id)
      : { cells: working, slot: placeLooseCell({ cells: working, edges: document.edges }) }
    const makeRoom = movedAny(working, placed.cells)
    working = [...placed.cells, {
      id: `routed-output-${index}`,
      type: output.type,
      slot: placed.slot,
      inputs: output.inputs,
    }]
    return {
      cell: {
        type: output.type,
        slot: placed.slot,
        inputs: output.inputs,
        output_artifact_id: output.artifactId,
      },
      makeRoom,
    }
  })
}

export function routedMediaCellInputs(
  tool: string,
  result: unknown,
  document: RoutedNotebook,
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
  const unplaced = outputs.filter((output) => !document.cells.some((cell) =>
    !isPublishedPostCell(cell) && cell.outputArtifactId === output.artifactId))
  return placeRoutedOutputs(unplaced, document)
}

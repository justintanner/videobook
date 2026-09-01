import {
  notebookGridTag,
  parseNotebookGridAddress,
} from 'videobook-engine/notebook-grid'
import { NOTEBOOK_GRID_ADDRESS_SOURCE } from 'videobook-engine/notebook-mentions'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
  NotebookGridSlot,
} from 'videobook-engine'
import { notebookCellAtSlot } from './notebook-addressing'
import { nextNotebookCreationSlot } from './notebook-grid'

type NotebookCoordinateAction =
  | {
      kind: 'move'
      source: NotebookGridSlot
      destination: NotebookGridSlot
    }
  | {
      kind: 'create'
      cellType: NotebookCellType
      destination: NotebookGridSlot | null
    }
  | {
      kind: 'delete' | 'run'
      source: NotebookGridSlot
    }
  | {
      kind: 'connect'
      source: NotebookGridSlot
      target: NotebookGridSlot
      targetInput: string | null
    }

export type NotebookAddressExpectation = {
  address: string
  cellId: string | null
}

export type NotebookCoordinateActionPlan = {
  action: NotebookCoordinateAction
  expectations: NotebookAddressExpectation[]
  reason: string
  summary: string
}

const cellTypes = new Map<string, NotebookCellType>([
  ['audio', 'audio'],
  ['image', 'image'],
  ['video', 'video'],
  ['extract audio', 'extract_audio'],
  ['split video', 'split_video'],
  ['prompt', 'prompt'],
  ['character', 'character'],
  ['analyze', 'analyze'],
  ['analysis', 'analysis'],
  ['generate video', 'generate_video'],
  ['generate image', 'generate_image'],
  ['generate audio', 'generate_audio'],
  ['concat', 'concat'],
  ['splice', 'splice'],
])

const addressPattern = `(${NOTEBOOK_GRID_ADDRESS_SOURCE})`

function address(value: string): NotebookGridSlot {
  const slot = parseNotebookGridAddress(value)
  if (!slot) throw new Error(`Invalid notebook address: @${value}`)
  return slot
}

function addressedCell(
  document: NotebookDocument,
  slot: NotebookGridSlot,
): NotebookCell {
  const cell = notebookCellAtSlot(document, slot)
  if (!cell) throw new Error(`Notebook cell ${notebookGridTag(slot)} is empty`)
  return cell
}

function expectation(
  document: NotebookDocument,
  slot: NotebookGridSlot,
): NotebookAddressExpectation {
  return {
    address: notebookGridTag(slot),
    cellId: notebookCellAtSlot(document, slot)?.id ?? null,
  }
}

export function parseNotebookCoordinateAction(
  input: string,
): NotebookCoordinateAction | null {
  const normalized = input.trim().replace(/[.!]+$/u, '')
  const move = normalized.match(new RegExp(
    `^(?:please\\s+)?(?:move|swap)\\s+@${addressPattern}\\s+(?:to|with|and)\\s+@${addressPattern}(?:\\s+please)?$`,
    'iu',
  ))
  if (move) {
    return {
      kind: 'move',
      source: address(move[1]!),
      destination: address(move[2]!),
    }
  }
  const create = normalized.match(new RegExp(
    `^(?:please\\s+)?(?:create|add)\\s+(?:a\\s+|an\\s+|new\\s+)*(extract audio|split video|generate video|generate image|generate audio|audio|image|video|prompt|character|analyze|analysis|concat|splice)(?:\\s+cell)?(?:\\s+(?:at|in|on)\\s+@${addressPattern})?(?:\\s+please)?$`,
    'iu',
  ))
  if (create) {
    return {
      kind: 'create',
      cellType: cellTypes.get(create[1]!.toLowerCase())!,
      destination: create[2] ? address(create[2]) : null,
    }
  }
  const simple = normalized.match(new RegExp(
    `^(?:please\\s+)?(delete|remove|run|execute)(?:\\s+(?:cell|output|output of))?\\s+@${addressPattern}(?:\\s+please)?$`,
    'iu',
  ))
  if (simple) {
    const verb = simple[1]!.toLowerCase()
    return {
      kind: verb === 'delete' || verb === 'remove'
        ? 'delete'
        : 'run',
      source: address(simple[2]!),
    }
  }
  const connect = normalized.match(new RegExp(
    `^(?:please\\s+)?connect\\s+@${addressPattern}\\s+to\\s+@${addressPattern}(?:\\s+(?:as|into|on)\\s+([a-z0-9_-]+))?(?:\\s+please)?$`,
    'iu',
  ))
  if (connect) {
    return {
      kind: 'connect',
      source: address(connect[1]!),
      target: address(connect[2]!),
      targetInput: connect[3]?.toLowerCase() ?? null,
    }
  }
  return null
}

export function planNotebookCoordinateAction(
  document: NotebookDocument,
  parsed: NotebookCoordinateAction,
  lastWorkSlot: NotebookGridSlot | null = null,
): NotebookCoordinateActionPlan {
  if (parsed.kind === 'create') {
    const destination = parsed.destination
      ?? nextNotebookCreationSlot(
        parsed.cellType,
        document.cells,
        lastWorkSlot,
      )
    const occupied = notebookCellAtSlot(document, destination)
    if (occupied) {
      throw new Error(`Notebook cell ${notebookGridTag(destination)} is occupied`)
    }
    return {
      action: { ...parsed, destination },
      expectations: [expectation(document, destination)],
      reason: 'This request creates a notebook cell',
      summary: `Create a ${parsed.cellType.replaceAll('_', ' ')} cell at ${notebookGridTag(destination)}`,
    }
  }
  if (parsed.kind === 'move') {
    const source = addressedCell(document, parsed.source)
    if (
      parsed.source.row === parsed.destination.row
      && parsed.source.column === parsed.destination.column
    ) {
      throw new Error(`${notebookGridTag(parsed.source)} is already there`)
    }
    const target = notebookCellAtSlot(document, parsed.destination)
    return {
      action: parsed,
      expectations: [
        expectation(document, parsed.source),
        expectation(document, parsed.destination),
      ],
      reason: target
        ? 'This request swaps two notebook cells'
        : 'This request moves a notebook cell',
      summary: target
        ? `Swap ${notebookGridTag(source.slot)} with ${notebookGridTag(target.slot)}`
        : `Move ${notebookGridTag(source.slot)} to ${notebookGridTag(parsed.destination)}`,
    }
  }
  if (parsed.kind === 'connect') {
    const source = addressedCell(document, parsed.source)
    const target = addressedCell(document, parsed.target)
    if (source.id === target.id) throw new Error('A cell cannot connect to itself')
    return {
      action: parsed,
      expectations: [
        expectation(document, parsed.source),
        expectation(document, parsed.target),
      ],
      reason: 'This request changes notebook connections',
      summary: `Connect ${notebookGridTag(source.slot)} to ${notebookGridTag(target.slot)}`,
    }
  }
  const source = addressedCell(document, parsed.source)
  return {
    action: parsed,
    expectations: [expectation(document, parsed.source)],
    reason: parsed.kind === 'run'
      ? 'This request runs a notebook cell'
      : 'This request permanently deletes a notebook cell',
    summary: `${parsed.kind[0]!.toUpperCase()}${parsed.kind.slice(1)} ${notebookGridTag(source.slot)}`,
  }
}

export function notebookAddressExpectationsAreStale(
  document: NotebookDocument,
  expectations: readonly NotebookAddressExpectation[],
): boolean {
  return expectations.some((expected) => {
    const slot = parseNotebookGridAddress(expected.address)
    if (!slot) return true
    return (notebookCellAtSlot(document, slot)?.id ?? null) !== expected.cellId
  })
}

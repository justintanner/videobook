import type { NotebookGridSlot } from 'videobook-engine'
import {
  generatorRoundsOf,
  notebookPromptTokens,
  notebookRoundHeaderSlots,
  notebookRoundsModel,
  type RoundsDocument,
} from '../../server/src/notebook-rounds'

export type NotebookPromptChange =
  | { kind: 'first' }
  | { kind: 'rewritten' }
  | { kind: 'edited'; removed: string[]; added: string[] }

export interface NotebookRoundHeader {
  generatorId: string
  slot: NotebookGridSlot
  version: number
  takeCount: number
  prompt: string
  change: NotebookPromptChange
}

type DiffKind = 'same' | 'removed' | 'added'

interface DiffToken {
  kind: DiffKind
  token: string
}

const REWRITE_SIMILARITY = 0.5
const DIFF_CELL_LIMIT = 40_000
const PUNCTUATION = /^[,.;:!?]$/u

function sameToken(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sharedEnds(previous: readonly string[], next: readonly string[]): { prefix: number; suffix: number } {
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && sameToken(previous[prefix]!, next[prefix]!)) prefix += 1
  let suffix = 0
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && sameToken(previous[previous.length - 1 - suffix]!, next[next.length - 1 - suffix]!)
  ) suffix += 1
  return { prefix, suffix }
}

function lcsTable(previous: readonly string[], next: readonly string[]): number[][] {
  const table = Array.from({ length: previous.length + 1 }, () => new Array<number>(next.length + 1).fill(0))
  for (let i = 1; i <= previous.length; i += 1) {
    for (let j = 1; j <= next.length; j += 1) {
      table[i]![j] = sameToken(previous[i - 1]!, next[j - 1]!)
        ? table[i - 1]![j - 1]! + 1
        : Math.max(table[i - 1]![j]!, table[i]![j - 1]!)
    }
  }
  return table
}

function middleDiff(previous: readonly string[], next: readonly string[]): DiffToken[] {
  const table = lcsTable(previous, next)
  const tokens: DiffToken[] = []
  let i = previous.length
  let j = next.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && sameToken(previous[i - 1]!, next[j - 1]!)) {
      tokens.push({ kind: 'same', token: next[j - 1]! })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!)) {
      tokens.push({ kind: 'added', token: next[j - 1]! })
      j -= 1
    } else {
      tokens.push({ kind: 'removed', token: previous[i - 1]! })
      i -= 1
    }
  }
  return tokens.reverse()
}

function joinTokens(tokens: readonly string[]): string {
  return tokens
    .reduce((text, token) => (PUNCTUATION.test(token) || text === '' ? `${text}${token}` : `${text} ${token}`), '')
    .replace(/^[\s,.;:!?]+/u, '')
    .replace(/[\s,;:]+$/u, '')
}

function changedRuns(tokens: readonly DiffToken[], kind: Exclude<DiffKind, 'same'>): string[] {
  const runs: string[][] = []
  let open = false
  for (const entry of tokens) {
    if (entry.kind === kind) {
      if (!open) runs.push([])
      runs.at(-1)!.push(entry.token)
      open = true
    } else if (entry.kind === 'same') {
      open = false
    }
  }
  return runs.map(joinTokens).filter((run) => run.length > 0)
}

export function notebookPromptChange(previous: string, next: string): NotebookPromptChange {
  const before = notebookPromptTokens(previous)
  const after = notebookPromptTokens(next)
  const { prefix, suffix } = sharedEnds(before, after)
  const middleBefore = before.slice(prefix, before.length - suffix)
  const middleAfter = after.slice(prefix, after.length - suffix)
  if (middleBefore.length * middleAfter.length > DIFF_CELL_LIMIT) return { kind: 'rewritten' }
  const middle = middleDiff(middleBefore, middleAfter)
  const same = prefix + suffix + middle.filter((entry) => entry.kind === 'same').length
  const similarity = (2 * same) / Math.max(1, before.length + after.length)
  if (similarity < REWRITE_SIMILARITY) return { kind: 'rewritten' }
  return { kind: 'edited', removed: changedRuns(middle, 'removed'), added: changedRuns(middle, 'added') }
}

export function notebookRoundHeaders(document: RoundsDocument): NotebookRoundHeader[] {
  const model = notebookRoundsModel(document)
  return notebookRoundHeaderSlots(model).flatMap((header) => {
    const rounds = generatorRoundsOf(model, header.generatorId)
    const round = rounds?.rounds[header.round]
    if (!rounds || !round) return []
    const previous = rounds.rounds[header.round - 1]
    return [{
      generatorId: header.generatorId,
      slot: header.slot,
      version: header.round + 1,
      takeCount: round.takeIds.length,
      prompt: round.prompt,
      change: previous ? notebookPromptChange(previous.prompt, round.prompt) : { kind: 'first' },
    }]
  })
}

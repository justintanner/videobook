import type { VoiceCaption, VoicePhase } from '../../server/src/voice-contract'
import type { McpCall, McpCallLog } from './mcp-activity'
import { chatTurnActive, type ChatTurn } from './chat-turns'

export const COMPOSER_HISTORY_CAP = 256
export const HISTORY_AUTO_CLOSE_MS = 60_000
const VISIBLE_EXCHANGES = 2

export type ComposerHistoryRow =
  | { kind: 'caption'; sequence: number; caption: VoiceCaption; turn?: ChatTurn; calls?: readonly McpCall[] }
  | { kind: 'call'; sequence: number; call: McpCall }
  | { kind: 'status'; sequence: number; text: string; goalId: string }

export type ComposerStatusRow = Extract<ComposerHistoryRow, { kind: 'status' }>

function captionCounts(caption: VoiceCaption): boolean {
  return caption.text.trim().length > 0 || Boolean(caption.interrupted)
}

/**
 * Interleave captions and MCP calls by sequence, then window to the last two
 * spoken exchanges. Blank captions are dropped before the window is measured.
 * A conversation with fewer than two user turns stays whole.
 */
export function composerHistory(
  captions: readonly VoiceCaption[],
  log: McpCallLog,
  turns: readonly ChatTurn[] = [],
  statuses: readonly ComposerStatusRow[] = [],
): ComposerHistoryRow[] {
  const captionRows: ComposerHistoryRow[] = captions.filter(captionCounts).map((caption) => ({
    kind: 'caption',
    sequence: caption.sequence ?? 0,
    caption,
  }))
  const turnRows: ComposerHistoryRow[] = turns.map(turn => ({
    kind: 'caption', sequence: turn.id, turn,
    caption: { id: `typed:${turn.id}`, sequence: turn.id, role: 'user', text: turn.text, final: true },
    calls: log.calls.filter(call => call.turnId === turn.id),
  }))
  const callRows: ComposerHistoryRow[] = log.calls.filter(call => call.turnId === undefined).map((call) => ({
    kind: 'call',
    sequence: call.id,
    call,
  }))
  const merged = [...captionRows, ...turnRows, ...callRows, ...statuses].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
    if (left.kind === right.kind) return 0
    return left.kind === 'caption' ? -1 : 1
  })
  const spoken = merged.flatMap((row, index) =>
    row.kind === 'caption' && row.caption.role === 'user' ? [index] : [])
  const from = spoken.at(-VISIBLE_EXCHANGES)
  return from === undefined ? merged : merged.filter((row, index) => index >= from
    || (row.kind === 'caption' && row.turn && chatTurnActive(row.turn)))
}

export function composerHistoryEpoch(rows: readonly ComposerHistoryRow[]): number {
  return rows.at(-1)?.sequence ?? 0
}

export function composerHistoryGeneration(rows: readonly ComposerHistoryRow[]): string {
  return rows.map((row) =>
    row.kind === 'status' ? `${row.sequence}:${row.text}` : row.kind === 'call' ? `${row.sequence}:${row.call.phase}` : row.turn
      ? `${row.sequence}:${row.turn.status}:${row.turn.reply}:${row.turn.work.map(work => work.state).join(':')}`
      : String(row.sequence)).join(',')
}

export function historyAutoCloseHeld(input: {
  runningCalls: number
  voicePhase: VoicePhase | undefined
}): boolean {
  if (input.runningCalls > 0) return true
  switch (input.voicePhase) {
    case 'connecting':
    case 'thinking':
    case 'speaking':
    case 'review':
      return true
    default:
      return false
  }
}

export function scheduleHistoryAutoClose(input: {
  open: boolean
  held: boolean
  delayMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  onClose: () => void
}): () => void {
  if (!input.open || input.held) return () => undefined
  const start = input.setTimeoutFn ?? setTimeout
  const stop = input.clearTimeoutFn ?? clearTimeout
  const timer = start(input.onClose, input.delayMs ?? HISTORY_AUTO_CLOSE_MS)
  return () => {
    stop(timer)
  }
}

export function historyIdle(
  phase: VoicePhase | undefined,
  rows: number,
  voicePresent: boolean,
): boolean {
  if (rows > 0) return false
  if (!voicePresent) return true
  return phase === 'off' || phase === undefined
}

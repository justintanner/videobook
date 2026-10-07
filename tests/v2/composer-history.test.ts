import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerHistory,
} from '../../src/components/videobook/ComposerHistory'
import { ComposerHistoryChromeContext } from '../../src/components/videobook/composer-history-chrome'
import {
  COMPOSER_HISTORY_CAP,
  HISTORY_AUTO_CLOSE_MS,
  composerHistory,
  composerHistoryEpoch,
  historyAutoCloseHeld,
  historyIdle,
  scheduleHistoryAutoClose,
  type ComposerHistoryRow,
} from '../../src/videobook/composer-history'
import {
  beginMcpCall,
  emptyMcpCallLog,
  mcpCallArgs,
  settleMcpCall,
  type McpCallLog,
} from '../../src/videobook/mcp-activity'
import { nextHistorySequence, resetHistorySequence } from '../../src/videobook/history-sequence'
import type { VoiceCaption } from '../../server/src/voice-contract'

afterEach(() => {
  resetHistorySequence()
  vi.useRealTimers()
})

const caption = (
  overrides: Partial<VoiceCaption> & Pick<VoiceCaption, 'id'>,
): VoiceCaption => ({
  role: 'user',
  text: 'hello',
  final: true,
  sequence: overrides.sequence ?? Number(String(overrides.id).replace(/\D/g, '') || 1),
  ...overrides,
})

function started(log: McpCallLog, id: number, tool: string, args: Record<string, unknown> = {}) {
  return beginMcpCall(log, { id, tool, args: mcpCallArgs(args) })
}

function historyCall(row: ComposerHistoryRow) {
  if (row.kind !== 'call') throw new Error(`Expected a call row, received ${row.kind}`)
  return row.call
}

describe('history sequence', () => {
  it('stamps captions and calls from one monotonic clock', () => {
    expect(nextHistorySequence()).toBe(1)
    expect(nextHistorySequence()).toBe(2)
  })
})

describe('composerHistory', () => {
  it('interleaves goal wake-ups with messages as STATUS rows without replacing replies', () => {
    const rows = composerHistory([
      caption({ id: 'u1', text: 'Make two clips', sequence: 1 }),
      caption({ id: 'a1', role: 'assistant', text: 'Your plan is saved', sequence: 2 }),
    ], emptyMcpCallLog, [], [
      { kind: 'status', sequence: 3, goalId: 'goal-one', text: 'Goal woke up · Full frame ready · Review full frame · @a3' },
      { kind: 'status', sequence: 4, goalId: 'goal-one', text: 'Goal woke up · Frame approved · Storyboard 1 of 2 · Generating · @a3' },
    ])
    expect(rows.map(row => row.kind)).toEqual(['caption', 'caption', 'status', 'status'])
    const markup = renderToStaticMarkup(createElement(ComposerHistory, { rows, phase: 'off', voicePresent: false, open: true, onToggleCall: () => undefined }))
    expect(markup).toContain('Your plan is saved')
    expect(markup.match(/>STATUS</gu)).toHaveLength(2)
    expect(markup).toContain('Full frame ready')
    expect(composerHistoryEpoch(rows)).toBe(4)
  })
  it('keeps interrupted or non-empty rows and drops blank YOU/COPILOT rows', () => {
    const rows = composerHistory([
      caption({ id: 'empty', text: '   ', final: false, sequence: 1 }),
      caption({ id: 'partial', text: 'hi', final: false, sequence: 2 }),
      caption({ id: 'cut', text: '', interrupted: true, final: true, sequence: 3 }),
    ], emptyMcpCallLog)
    expect(rows.map((row) => row.kind === 'caption' ? row.caption.id : historyCall(row).id))
      .toEqual(['partial', 'cut'])
  })

  it('shows the last two exchanges plus every call that fired inside them', () => {
    const log = started(
      started(emptyMcpCallLog, 3, 'plan_chat_command'),
      6,
      'chain',
    )
    const captions = [
      caption({ id: 'u1', text: 'oldest ask', sequence: 1 }),
      caption({ id: 'a1', role: 'assistant', text: 'oldest reply', sequence: 2 }),
      caption({ id: 'u2', text: 'newer ask', sequence: 4 }),
      caption({ id: 'a2', role: 'assistant', text: 'newer reply', sequence: 5 }),
      caption({ id: 'u3', text: 'newest ask', sequence: 7 }),
      caption({ id: 'a3', role: 'assistant', text: 'newest reply', sequence: 8 }),
    ]
    const rows = composerHistory(captions, log)
    expect(rows.map((row) => row.kind === 'caption' ? row.caption.id : `call:${historyCall(row).tool}`))
      .toEqual(['u2', 'a2', 'call:chain', 'u3', 'a3'])
    expect(rows.some((row) => row.kind === 'caption' && row.caption.id === 'u1')).toBe(false)
    expect(rows.some((row) => row.kind === 'call' && row.call.tool === 'plan_chat_command')).toBe(false)
  })

  it('keeps a streaming assistant row in place while it grows and when it turns final', () => {
    const streaming = caption({
      id: 'a1',
      role: 'assistant',
      text: 'Ready',
      final: false,
      sequence: 2,
    })
    const withCall = started(emptyMcpCallLog, 3, 'chat')
    const growing = composerHistory([
      caption({ id: 'u1', text: 'make a clip', sequence: 1 }),
      { ...streaming, text: 'Ready to apply the cut.' },
    ], withCall)
    expect(growing.map((row) => row.kind === 'caption' ? row.caption.id : `call:${historyCall(row).id}`))
      .toEqual(['u1', 'a1', 'call:3'])
    const final = composerHistory([
      caption({ id: 'u1', text: 'make a clip', sequence: 1 }),
      { ...streaming, text: 'Ready to apply the cut.', final: true },
    ], withCall)
    expect(final.map((row) => row.kind === 'caption' ? row.caption.id : `call:${historyCall(row).id}`))
      .toEqual(['u1', 'a1', 'call:3'])
    expect(final[1]).toMatchObject({ kind: 'caption', caption: { final: true } })
  })

  it('keeps a short conversation whole, including anything said before the first turn', () => {
    const greeting = caption({ id: 'a0', role: 'assistant', text: 'Voice ready.', sequence: 1 })
    expect(composerHistory([greeting], emptyMcpCallLog).map((row) =>
      row.kind === 'caption' ? row.caption.id : historyCall(row).id)).toEqual(['a0'])
    expect(composerHistory([
      greeting,
      caption({ id: 'u1', text: 'hello', sequence: 2 }),
      caption({ id: 'a1', role: 'assistant', text: 'hi', sequence: 3 }),
    ], emptyMcpCallLog).map((row) =>
      row.kind === 'caption' ? row.caption.id : historyCall(row).id)).toEqual(['a0', 'u1', 'a1'])
  })

  it('counts an exchange from the speaker, not from every row', () => {
    expect(composerHistory([
      caption({ id: 'u1', text: 'one', sequence: 1 }),
      caption({ id: 'u2', text: 'two', sequence: 2 }),
      caption({ id: 'u3', text: 'three', sequence: 3 }),
    ], emptyMcpCallLog).map((row) =>
      row.kind === 'caption' ? row.caption.id : historyCall(row).id)).toEqual(['u2', 'u3'])
    expect(composerHistory([
      caption({ id: 'u1', text: 'one', sequence: 1 }),
      caption({ id: 'blank', text: '   ', final: false, sequence: 2 }),
      caption({ id: 'a1', role: 'assistant', text: 'reply', sequence: 3 }),
    ], emptyMcpCallLog).map((row) =>
      row.kind === 'caption' ? row.caption.id : historyCall(row).id)).toEqual(['u1', 'a1'])
  })

  it('renders calls with voice off and with no captions, and empty copy only when merged list is empty', () => {
    const log = started(emptyMcpCallLog, 1, 'chat')
    const withCalls = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([], log),
      phase: 'off',
      voicePresent: false,
      open: true,
      onToggleCall: () => undefined,
    }))
    expect(withCalls).toContain('>Routing chat<')
    expect(withCalls).not.toContain('No captions this session.')

    const empty = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([], emptyMcpCallLog),
      phase: 'connecting',
      voicePresent: true,
      open: true,
      onToggleCall: () => undefined,
    }))
    expect(empty).toContain('Opening your voice channel')
    expect(historyIdle('off', 0, false)).toBe(true)
    expect(historyIdle('connecting', 0, true)).toBe(false)
  })

  it('closes without touching call, review or voice controls', () => {
    const log = started(emptyMcpCallLog, 1, 'chat')
    const html = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([caption({ id: 'u1', text: 'hello', sequence: 1 })], log),
      phase: 'review',
      voicePresent: true,
      open: true,
      onToggleCall: () => undefined,
    }))
    expect(html).toContain('aria-label="Message log"')
    expect(html).not.toContain('voice-captions-toggle')
    expect(html).toContain('mcp-call-running')
    const closed = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([caption({ id: 'u1', text: 'hello', sequence: 1 })], log),
      phase: 'speaking',
      voicePresent: true,
      open: false,
      onToggleCall: () => undefined,
    }))
    expect(closed).toContain(' hidden=""')
    expect(closed).toContain('>hello</span>')
    expect(closed).toContain('mcp-call-running')
  })
})

describe('history auto-close', () => {
  it('closes 60s after the newest row and holds during in-flight work', () => {
    vi.useFakeTimers()
    const closed: number[] = []
    const hold = historyAutoCloseHeld({ runningCalls: 1, voicePhase: 'listening' })
    expect(hold).toBe(true)
    expect(historyAutoCloseHeld({ runningCalls: 0, voicePhase: 'connecting' })).toBe(true)
    expect(historyAutoCloseHeld({ runningCalls: 0, voicePhase: 'thinking' })).toBe(true)
    expect(historyAutoCloseHeld({ runningCalls: 0, voicePhase: 'speaking' })).toBe(true)
    expect(historyAutoCloseHeld({ runningCalls: 0, voicePhase: 'review' })).toBe(true)
    expect(historyAutoCloseHeld({ runningCalls: 0, voicePhase: 'listening' })).toBe(false)

    const first = scheduleHistoryAutoClose({
      open: true,
      held: false,
      onClose: () => { closed.push(1) },
    })
    vi.advanceTimersByTime(HISTORY_AUTO_CLOSE_MS - 1)
    expect(closed).toEqual([])
    first()
    const second = scheduleHistoryAutoClose({
      open: true,
      held: false,
      onClose: () => { closed.push(2) },
    })
    vi.advanceTimersByTime(HISTORY_AUTO_CLOSE_MS)
    expect(closed).toEqual([2])
    second()
    const heldTimer = scheduleHistoryAutoClose({
      open: true,
      held: true,
      onClose: () => { closed.push(3) },
    })
    vi.advanceTimersByTime(HISTORY_AUTO_CLOSE_MS * 2)
    expect(closed).toEqual([2])
    heldTimer()
  })

  it('renders no toggle chrome and keeps one close control in the composer', () => {
    const log = settleMcpCall(started(emptyMcpCallLog, 1, 'chat'), 1, {
      phase: 'done',
      elapsedMs: 30,
      detail: '',
    })
    const rows = composerHistory([
      caption({ id: 'u1', text: 'hello', sequence: 2 }),
    ], log)
    const html = renderToStaticMarkup(createElement(ComposerHistory, {
      rows,
      phase: 'listening',
      voicePresent: true,
      open: true,
      onToggleCall: () => undefined,
    }))
    expect(html).not.toContain('composer-panel-controls')
    expect(html).not.toContain('voice-captions-toggle')
    expect(html).not.toContain('Captain’s Log')
    expect(html).toContain('aria-label="Message log"')
    expect(html).not.toContain('aria-label="Close chat"')
    expect(html).not.toContain('lucide-chevron-down')

    const hostedHtml = renderToStaticMarkup(createElement(
      ComposerHistoryChromeContext.Provider,
      { value: { captionId: 'hist' } },
      createElement(ComposerHistory, {
        rows,
        phase: 'listening',
        voicePresent: true,
        open: true,
        onToggleCall: () => undefined,
      }),
    ))
    expect(hostedHtml).toContain('id="hist"')
    expect(hostedHtml).not.toContain('composer-panel-controls')

    const appCss = readFileSync(
      new URL('../../src/index.css', import.meta.url),
      'utf8',
    )
    expect(appCss).not.toContain('.voice-captions-toggle')
    const composerTsx = readFileSync(
      new URL('../../src/components/videobook/CommandComposer.tsx', import.meta.url),
      'utf8',
    )
    expect(composerTsx.match(/<ComposerDockClose \/>/g)).toHaveLength(1)
  })

  it('labels both speakers and actions with the same history row structure', () => {
    const html = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([
        caption({ id: 'u1', text: 'hello', sequence: 1 }),
        caption({ id: 'a1', role: 'assistant', text: 'ready', sequence: 3 }),
      ], started(emptyMcpCallLog, 2, 'chat')),
      phase: 'listening',
      voicePresent: true,
      open: true,
      onToggleCall: () => undefined,
    }))
    expect(html).toContain('data-role="user"')
    expect(html).toContain('data-role="assistant"')
    expect(html).toContain('>YOU</span>')
    expect(html).toContain('>COPILOT</span>')
    expect(html).toContain('>ACTION</span>')
    expect(html.match(/class="composer-history-entry/g)).toHaveLength(3)
    expect(html).not.toContain('composer-history-close')
  })

  it('tracks the newest sequence so a later row restarts the window', () => {
    const log = settleMcpCall(started(emptyMcpCallLog, 4, 'chat'), 4, {
      phase: 'done',
      elapsedMs: 20,
      detail: '',
    })
    const rows = composerHistory([
      caption({ id: 'u1', text: 'one', sequence: 1 }),
      caption({ id: 'a1', role: 'assistant', text: 'two', sequence: 2 }),
    ], log)
    expect(composerHistoryEpoch(rows)).toBe(4)
    expect(COMPOSER_HISTORY_CAP).toBeGreaterThan(12)
  })
})

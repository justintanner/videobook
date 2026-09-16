import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VoiceComms } from '../../src/components/videobook/VoiceComms'
import { ComposerHistory } from '../../src/components/videobook/ComposerHistory'
import { composerHistory } from '../../src/videobook/composer-history'
import { composerActivityStatus } from '../../src/videobook/composer-status'
import { emptyMcpCallLog } from '../../src/videobook/mcp-activity'
import type { VoiceConversation } from '../../src/videobook/use-voice-conversation'

function stubVoice(overrides: Partial<VoiceConversation> = {}): VoiceConversation {
  return {
    phase: 'listening',
    message: 'Speak naturally. Interrupt anytime.',
    captions: [],
    playbackBlocked: false,
    pendingReview: false,
    retrying: false,
    meterRef: createRef<HTMLButtonElement>(),
    toggle: () => undefined,
    stop: () => undefined,
    mode: 'auto',
    provider: 'openai',
    fallbackReason: undefined,
    selectMode: () => undefined,
    disabled: false,
    active: true,
    resumePlayback: () => undefined,
    reportOutcome: () => undefined,
    shareTypedTurn: () => undefined,
    ...overrides,
  }
}

describe('composer activity status', () => {
  it('keeps Connecting voice distinct from Waiting for reply', () => {
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'connecting' }))
      .toEqual({ kind: 'connecting', label: 'Connecting voice', busy: true })
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'thinking' }))
      .toEqual({ kind: 'waiting', label: 'Waiting for reply', busy: true })
    expect(composerActivityStatus({
      sending: false,
      mcpRunning: 0,
      voicePhase: 'connecting',
      voiceMessage: 'Allow microphone access',
    }).label).toBe('Allow microphone access')
  })

  it('acknowledges send immediately and keeps background polling out of busy', () => {
    expect(composerActivityStatus({ sending: true, mcpRunning: 0, voicePhase: 'listening' }))
      .toMatchObject({ kind: 'sending', label: 'Sending', busy: true })
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'listening' }).busy)
      .toBe(false)
  })

  it('names listening, preparing, review, speaking, retry, paused and error truthfully', () => {
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'listening' }).label)
      .toBe('Listening')
    expect(composerActivityStatus({ sending: false, mcpRunning: 1, voicePhase: 'listening' }).label)
      .toBe('Preparing an action')
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'review' }).label)
      .toBe('Review on screen')
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'speaking' }).label)
      .toBe('Speaking')
    expect(composerActivityStatus({
      sending: false,
      mcpRunning: 0,
      voicePhase: 'thinking',
      retrying: true,
    }).label).toBe('Retrying reply')
    expect(composerActivityStatus({
      sending: false,
      mcpRunning: 0,
      voicePhase: 'off',
      voiceMessage: 'Comms off while the page is hidden.',
    }).label).toBe('Voice paused. Start voice to resume.')
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'error' }))
      .toMatchObject({ kind: 'error', busy: false })
  })

  it('clears busy after complete, stop, interrupt, failure and scope change', () => {
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'listening' }).busy)
      .toBe(false)
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'off' }).busy)
      .toBe(false)
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'error' }).busy)
      .toBe(false)
    expect(composerActivityStatus({ sending: false, mcpRunning: 0, voicePhase: 'review' }).busy)
      .toBe(false)
  })

  it('does not treat a leftover pending review as busy work after voice stops', () => {
    const stopped = composerActivityStatus({
      sending: false,
      mcpRunning: 0,
      voicePhase: 'off',
      pendingReview: true,
    })
    expect(stopped.busy).toBe(false)
    expect(stopped.label).not.toBe('Preparing an action')
    expect(stopped.kind).not.toBe('preparing')
    const failed = composerActivityStatus({
      sending: false,
      mcpRunning: 0,
      voicePhase: 'error',
      pendingReview: true,
    })
    expect(failed.busy).toBe(false)
    expect(failed.label).not.toBe('Preparing an action')
    expect(composerActivityStatus({
      sending: false,
      mcpRunning: 0,
      voicePhase: 'thinking',
      pendingReview: true,
    })).toMatchObject({ kind: 'preparing', label: 'Preparing an action', busy: true })
  })

  it('keeps Connecting voice and Waiting for reply visible when history is hidden', () => {
    const connecting = renderToStaticMarkup(createElement(VoiceComms, {
      voice: stubVoice({ phase: 'connecting', message: 'Connecting voice' }),
    }))
    const waiting = renderToStaticMarkup(createElement(VoiceComms, {
      voice: stubVoice({ phase: 'thinking', message: 'Speak naturally. Interrupt anytime.' }),
    }))
    const hidden = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([], emptyMcpCallLog),
      phase: 'connecting',
      voicePresent: true,
      open: false,
      onToggle: () => undefined,
      onClose: () => undefined,
      onToggleCall: () => undefined,
    }))
    expect(connecting).toContain('Connecting voice')
    expect(connecting).not.toContain('Waiting for reply')
    expect(waiting).toContain('Waiting for reply')
    expect(waiting).not.toContain('Connecting voice')
    expect(hidden).toContain(' hidden=""')
    expect(hidden).toContain('aria-label="Show history"')
    expect(connecting).toContain('Voice comms')
  })
})

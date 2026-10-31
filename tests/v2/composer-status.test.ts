import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VoiceActivity } from '../../src/components/videobook/VoiceActivity'
import { voiceActivityFeedback } from '../../src/videobook/composer-status'
import { ComposerModeSwitch } from '../../src/components/videobook/ComposerModeSwitch'
import { ComposerHistory } from '../../src/components/videobook/ComposerHistory'
import { composerHistory } from '../../src/videobook/composer-history'
import {
  composerActivityStatus,
  composerActivityWorthShowing,
} from '../../src/videobook/composer-status'
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

function renderVoiceActivity(voice: VoiceConversation): string {
  const feedback = voiceActivityFeedback(voice)
  return feedback ? renderToStaticMarkup(createElement(VoiceActivity, {
    feedback,
    onResumePlayback: voice.resumePlayback,
  })) : ''
}

function voiceButtonMarkup(voice: VoiceConversation): string {
  return renderToStaticMarkup(createElement(ComposerModeSwitch, {
    chatModels: [],
    selectedModel: 'astra',
    modelSelectionDisabled: false,
    sending: false,
    voice,
    onModelChange: () => undefined,
    onToggleVoice: () => undefined,
  }))
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
    expect(composerActivityStatus({ sending: true, mcpRunning: 0, voicePhase: 'error' }))
      .toMatchObject({ kind: 'sending', label: 'Sending', busy: true })
    expect(composerActivityStatus({ sending: true, mcpRunning: 0, voicePhase: 'review' }))
      .toMatchObject({ kind: 'sending', label: 'Sending', busy: true })
  })

  it('does not revive a stopped voice session for typed activity or a stale fallback', () => {
    const voice = stubVoice({
      phase: 'off',
      active: false,
      message: 'Comms off.',
      retrying: true,
      pendingReview: true,
      fallbackReason: 'The previous OpenAI session ended.',
    })
    expect(voiceActivityFeedback(voice)).toBeNull()
    expect(renderVoiceActivity(voice)).toBe('')
  })

  it('keeps actionable voice feedback in one bubble without a duplicate connection label', () => {
    const error = renderVoiceActivity(stubVoice({
      phase: 'error', active: false, message: 'Voice connection lost', playbackBlocked: true,
    }))
    expect(error).toContain('chat-bubble-assistant')
    expect(error).toContain('role="alert"')
    expect(error).toContain('Voice connection lost')
    expect(error).not.toContain('Connection error')
    expect(error).toContain('Enable spoken replies')
    const paused = renderVoiceActivity(stubVoice({
      phase: 'off', active: false, message: 'Comms off while the page is hidden.',
    }))
    expect(paused).toContain('Voice paused. Start voice to resume.')
    expect(paused).not.toContain('Comms off')
    const fallback = renderVoiceActivity(stubVoice({ fallbackReason: 'OpenAI is unavailable' }))
    expect(fallback).toContain('Using xAI')
    expect(fallback).toContain('OpenAI is unavailable')
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

  it('keeps connection status on the button and renders reply progress as a log bubble', () => {
    const voice = stubVoice({ phase: 'connecting', message: 'Connecting voice' })
    const connecting = voiceButtonMarkup(voice)
    const waiting = renderVoiceActivity(stubVoice({ phase: 'thinking' }))
    const hidden = renderToStaticMarkup(createElement(ComposerHistory, {
      rows: composerHistory([], emptyMcpCallLog),
      phase: 'connecting',
      voicePresent: true,
      open: false,
      onToggleCall: () => undefined,
    }))
    expect(connecting).toContain('Connecting voice')
    expect(connecting).not.toContain('Waiting for reply')
    expect(waiting).toContain('Waiting for reply')
    expect(waiting).not.toContain('Connecting voice')
    expect(hidden).toContain(' hidden=""')
    expect(hidden).toContain('aria-label="Message log"')
    expect(connecting).toMatch(/class="composer-mode-cell composer-phone"[^>]*data-voice-phase="connecting"/)
    expect(connecting).toContain('role="status"')
    expect(renderVoiceActivity(voice)).toBe('')
  })

  it('says nothing the rest of the screen is already saying', () => {
    // A review sheet is visibly on screen and a live microphone is lit in the
    // mode switch, so naming either in the transcript is a line of chrome.
    for (const kind of ['review', 'listening', 'idle'] as const) {
      expect(composerActivityWorthShowing({ kind, label: 'anything', busy: false })).toBe(false)
    }
    // Everything that is news keeps its line.
    for (const kind of ['permission', 'connecting', 'waiting', 'preparing', 'retrying', 'sending', 'paused', 'error', 'speaking'] as const) {
      expect(composerActivityWorthShowing({ kind, label: 'anything', busy: false })).toBe(true)
    }
    // An unnamed state draws nothing either.
    expect(composerActivityWorthShowing({ kind: 'error', label: '', busy: false })).toBe(false)
  })

  it('drops the review narration once the sheet is on screen to say it', () => {
    const review = renderVoiceActivity(stubVoice({ phase: 'review', message: 'Review on screen', active: true }))
    expect(review).not.toContain('Use Apply or Cancel on screen.')
    expect(review).not.toContain('voice-comms-statusline')
    expect(review).not.toContain('mic on')

    const permission = voiceButtonMarkup(stubVoice({ phase: 'connecting', message: 'Please allow microphone access' }))
    expect(permission).toContain('Allow microphone access')
  })
})

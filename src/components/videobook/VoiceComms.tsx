import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Mic, Radio, Square, Volume2 } from 'lucide-react'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import {
  captionToggleLabel,
  captionsEmptyCopy,
  displayableCaptions,
} from '@/videobook/voice-captions'
import type { VoicePhase } from '../../../server/src/voice-contract'
import './VoiceComms.css'

const labels: Record<VoicePhase, string> = {
  off: 'Offline', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', review: 'Review on screen', error: 'Connection error',
}

const PIN_THRESHOLD_PX = 28

export function VoiceToggle({ voice, onToggle }: { voice: VoiceConversation; onToggle: () => void }) {
  const { meterRef, phase, active, disabled } = voice
  return <div className="voice-controls">
    <label className="voice-provider-field">
      <span className="command-control-kind">Voice</span>
      <select className="voice-provider-select" aria-label="Voice provider" value={voice.mode} title="Auto tries OpenAI, then xAI if it cannot connect" onChange={event => voice.selectMode(event.target.value === 'openai' ? 'openai' : event.target.value === 'xai' ? 'xai' : 'auto')}>
        <option value="auto">Auto</option>
        <option value="openai">OpenAI</option>
        <option value="xai">xAI</option>
      </select>
    </label>
    <button
      ref={meterRef}
      type="button"
      className={`voice-toggle voice-${phase}`}
      aria-label={active ? 'Stop voice conversation' : 'Start voice conversation'}
      aria-pressed={active}
      disabled={!active && disabled}
      title={active ? 'Stop microphone and spoken replies' : 'Voice input + spoken replies'}
      onClick={onToggle}
    >
      <svg className="voice-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" /></svg>
      {active ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
    </button>
  </div>
}

export function VoiceComms({
  voice,
  captionsVisible,
}: {
  voice: VoiceConversation
  captionsVisible?: boolean
}) {
  const [visible, setVisible] = useState(true)
  const shown = captionsVisible ?? visible
  const captionId = useId()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const rows = displayableCaptions(voice.captions)
  const idle = voice.phase === 'off' && voice.captions.length === 0 && voice.message === 'Voice input + spoken replies'

  useLayoutEffect(() => {
    const element = scrollerRef.current
    if (idle || !element || !shown) return
    if (pinnedRef.current) element.scrollTop = element.scrollHeight
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
    pinnedRef.current = pinned
    setShowLatest(!pinned && rows.length > 0)
  }, [idle, shown, voice.captions, rows.length])

  if (idle) return null

  const toggleCaptions = () => {
    if (captionsVisible !== undefined) return
    setVisible(current => !current)
  }

  return <aside className={`voice-comms voice-${voice.phase}`} aria-label="Voice comms" data-captions-visible={shown ? 'true' : 'false'}>
    <div className="voice-comms-header">
      <Radio size={14} aria-hidden="true" />
      <strong>COMMS</strong>
      {voice.provider && <span className="voice-provider-badge">{voice.provider === 'xai' ? 'xAI' : 'OpenAI'}</span>}
      <span className="voice-comms-status" role="status">{labels[voice.phase]}</span>
      <button
        type="button"
        aria-controls={captionId}
        aria-expanded={shown}
        aria-label={captionToggleLabel(shown)}
        onMouseDown={event => event.preventDefault()}
        onClick={toggleCaptions}
      >
        <span>{captionToggleLabel(shown)}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    </div>
    {voice.fallbackReason && <details className="voice-fallback"><summary>Using xAI · OpenAI unavailable</summary><p>{voice.fallbackReason}</p></details>}
    {(voice.phase === 'error' || voice.phase === 'off') && (
      <p className="voice-comms-message" role={voice.phase === 'error' ? 'alert' : undefined}>{voice.message}</p>
    )}
    {voice.playbackBlocked && <button className="voice-resume" type="button" onClick={voice.resumePlayback}><Volume2 size={14} aria-hidden="true" />Enable spoken replies</button>}
    <div
      ref={scrollerRef}
      id={captionId}
      className="voice-captions"
      hidden={!shown}
      aria-label="Live voice captions"
      role="log"
      aria-live="off"
      onScroll={event => {
        const element = event.currentTarget
        const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX
        pinnedRef.current = pinned
        setShowLatest(!pinned && rows.length > 0)
      }}
    >
      {rows.length === 0
        ? <p className="voice-captions-empty">{captionsEmptyCopy(voice.phase)}</p>
        : rows.map(caption => <p key={caption.id} data-final={caption.final}>
            <strong>{caption.role === 'user' ? 'YOU' : 'COPILOT'}</strong>
            <span>{caption.text}{caption.interrupted && <em> · interrupted</em>}</span>
          </p>)}
    </div>
    {shown && showLatest && (
      <button
        type="button"
        className="voice-captions-latest"
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          pinnedRef.current = true
          setShowLatest(false)
          const element = scrollerRef.current
          if (element) element.scrollTop = element.scrollHeight
        }}
      >
        Latest captions
      </button>
    )}
    {voice.phase === 'review' && <p className="voice-comms-review">Use Apply or Cancel on screen.</p>}
    {voice.active && <span className="voice-disclosure">AI voice · microphone on</span>}
  </aside>
}

import { useId, useState } from 'react'
import { ChevronDown, Mic, Radio, Square, Volume2 } from 'lucide-react'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import type { VoicePhase } from '../../../server/src/voice-contract'
import './VoiceComms.css'

const labels: Record<VoicePhase, string> = {
  off: 'Offline', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', review: 'Review on screen', error: 'Connection error',
}

export function VoiceToggle({ voice, onToggle }: { voice: VoiceConversation; onToggle: () => void }) {
  const { meterRef, phase, active, disabled } = voice
  return <button
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
}

export function VoiceComms({ voice }: { voice: VoiceConversation }) {
  const [expanded, setExpanded] = useState(false)
  const captionId = useId()
  if (voice.phase === 'off' && voice.captions.length === 0 && voice.message === 'Voice input + spoken replies') return null
  const visible = expanded ? voice.captions : voice.captions.slice(-2)
  return <aside className={`voice-comms voice-${voice.phase}`} aria-label="Voice comms">
    <div className="voice-comms-header">
      <Radio size={14} aria-hidden="true" />
      <strong>COMMS</strong>
      <span className="voice-comms-status" role="status">{labels[voice.phase]}</span>
      <button type="button" aria-controls={captionId} aria-expanded={expanded} aria-label={expanded ? 'Collapse voice captions' : 'Expand voice captions'} onClick={() => setExpanded(!expanded)}>
        <span>Captions</span><ChevronDown size={13} aria-hidden="true" />
      </button>
    </div>
    {voice.phase === 'error' || voice.phase === 'off'
      ? <p className="voice-comms-message" role={voice.phase === 'error' ? 'alert' : undefined}>{voice.message}</p>
      : visible.length === 0 ? <p className="voice-comms-message">{voice.phase === 'connecting' ? 'Opening your voice channel…' : 'Speak naturally. Interrupt anytime.'}</p> : null}
    {voice.playbackBlocked && <button className="voice-resume" type="button" onClick={voice.resumePlayback}><Volume2 size={14} aria-hidden="true" />Enable spoken replies</button>}
    <div id={captionId} className={`voice-captions ${expanded ? 'expanded' : ''}`} aria-label="Live voice captions" role="log" aria-live="off">
      {visible.map(caption => <p key={caption.id} data-final={caption.final}>
        <strong>{caption.role === 'user' ? 'YOU' : 'COPILOT'}</strong>
        <span>{caption.text}{caption.interrupted && <em> · interrupted</em>}</span>
      </p>)}
    </div>
    {voice.phase === 'review' && <p className="voice-comms-review">Use Apply or Cancel on screen.</p>}
    {voice.active && <span className="voice-disclosure">AI voice · microphone on</span>}
  </aside>
}

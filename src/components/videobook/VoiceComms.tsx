import { ChevronDown, Mic, Radio, Square, Volume2 } from 'lucide-react'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import { composerActivityStatus } from '@/videobook/composer-status'
import './VoiceComms.css'

// The chat model and the voice provider read as one control: a single bordered
// strip with two segments. Neither carries a visible field label any more, so
// the mic glyph is what marks this half as voice, and the select keeps the
// accessible name.
export function VoiceProviderSelect({ voice }: { voice: VoiceConversation }) {
  return <label className="voice-provider-field" title="Auto tries OpenAI, then xAI if it cannot connect">
    <Mic size={11} aria-hidden="true" />
    <select className="voice-provider-select" aria-label="Voice provider" value={voice.mode} onChange={event => voice.selectMode(event.target.value === 'openai' ? 'openai' : event.target.value === 'xai' ? 'xai' : 'auto')}>
      <option value="auto">Auto</option>
      <option value="openai">OpenAI</option>
      <option value="xai">xAI</option>
    </select>
    <ChevronDown size={11} aria-hidden="true" />
  </label>
}

export function VoiceToggle({ voice, onToggle }: { voice: VoiceConversation; onToggle: () => void }) {
  const { meterRef, phase, active, disabled } = voice
  return <div className="voice-controls">
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
      <svg className="voice-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19.5" /></svg>
      {active ? <Square size={13} fill="currentColor" aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
    </button>
  </div>
}

export function VoiceComms({
  voice,
  sending = false,
  mcpRunning = 0,
}: {
  voice: VoiceConversation
  sending?: boolean
  mcpRunning?: number
}) {
  const idle = voice.phase === 'off' && voice.captions.length === 0 && voice.message === 'Voice input + spoken replies'
  if (idle) return null
  const status = composerActivityStatus({
    sending,
    mcpRunning,
    voicePhase: voice.phase,
    voiceMessage: voice.message,
    retrying: voice.retrying,
    pendingReview: voice.pendingReview,
  })

  return <aside className={`voice-comms voice-${voice.phase}`} aria-label="Voice comms">
    {voice.fallbackReason && <details className="voice-fallback"><summary>Using xAI · OpenAI unavailable</summary><p>{voice.fallbackReason}</p></details>}
    {(voice.phase === 'error' || voice.phase === 'off') && (
      <p className="voice-comms-message" role={voice.phase === 'error' ? 'alert' : undefined}>{voice.message}</p>
    )}
    {voice.playbackBlocked && <button className="voice-resume" type="button" onClick={voice.resumePlayback}><Volume2 size={14} aria-hidden="true" />Enable spoken replies</button>}
    {voice.phase === 'review' && <p className="voice-comms-review">Use Apply or Cancel on screen.</p>}
    <div className="voice-comms-statusline">
      <Radio size={12} aria-hidden="true" />
      {voice.provider && <span className="voice-provider-badge">{voice.provider === 'xai' ? 'xAI' : 'OpenAI'}</span>}
      <span className="voice-comms-status" role="status">{status.label}</span>
      {voice.active && voice.phase !== 'connecting' && <span className="voice-disclosure">mic on</span>}
    </div>
  </aside>
}

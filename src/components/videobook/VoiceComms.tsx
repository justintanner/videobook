import { Radio, Volume2 } from 'lucide-react'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import { composerActivityStatus } from '@/videobook/composer-status'
import './VoiceComms.css'

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
      <span className="voice-comms-glyph"><Radio size={14} aria-hidden="true" /></span>
      {voice.provider && <span className="voice-provider-badge">{voice.provider === 'xai' ? 'xAI' : 'OpenAI'}</span>}
      <span className="voice-comms-status" role="status">{status.label}</span>
      {voice.active && voice.phase !== 'connecting' && <span className="voice-disclosure">mic on</span>}
    </div>
  </aside>
}

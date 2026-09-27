import { Volume2 } from 'lucide-react'
import type { VoiceActivityFeedback } from '@/videobook/composer-status'

export function VoiceActivity({
  feedback,
  onResumePlayback,
}: {
  feedback: VoiceActivityFeedback
  onResumePlayback: () => void
}) {
  return (
    <div
      className={`chat-bubble chat-bubble-assistant chat-voice-activity${feedback.error ? ' chat-voice-error' : ''}`}
      aria-label="Voice activity"
    >
      <span className="composer-history-kind">VOICE</span>
      {feedback.message && (
        <p className="chat-turn-status" role={feedback.error ? 'alert' : 'status'}>
          {feedback.busy && <span className="chat-working-dots" aria-hidden="true"><i /><i /><i /></span>}
          <span>{feedback.message}</span>
        </p>
      )}
      {feedback.fallbackReason && (
        <details className="voice-fallback">
          <summary>Using xAI · OpenAI unavailable</summary>
          <p>{feedback.fallbackReason}</p>
        </details>
      )}
      {feedback.playbackBlocked && (
        <button className="voice-resume" type="button" onClick={onResumePlayback}>
          <Volume2 size={14} aria-hidden="true" />Enable spoken replies
        </button>
      )}
    </div>
  )
}

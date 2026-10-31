import type { ReactNode } from 'react'
import type { RoutedActionSetting } from '@/videobook/chat-action-review'
import { PromptEcho, RoutedSettings } from './RoutedSettings'
import { SpeedChangePreview } from './SpeedChangePreview'

interface RoutedSpeedPreview {
  effectiveSpeed: number | null
  mediaUrl: string | null
  thumbnailUrl: string | null
  unavailableReason: string | null
}

export function RoutedBody({
  prompt,
  settings,
  speedPreview = null,
  preview = null,
  previewLayout = 'beside',
}: {
  prompt: string
  settings: readonly RoutedActionSetting[]
  speedPreview?: RoutedSpeedPreview | null
  preview?: ReactNode
  previewLayout?: 'beside' | 'full'
}) {
  if (preview && previewLayout === 'full') {
    return (
      <div className="confirm-routed confirm-routed-full-preview">
        <PromptEcho prompt={prompt} />
        <div className="confirm-routed-preview">{preview}</div>
      </div>
    )
  }
  const withPreview = Boolean(speedPreview || preview)
  const columns = withPreview ? 2 : Math.min(6, Math.max(1, settings.length))
  return (
    <div className={`confirm-routed${withPreview ? ' confirm-routed-with-preview' : ''}`}>
      <div className="confirm-routed-main">
        <PromptEcho prompt={prompt} />
        <RoutedSettings columns={columns} settings={settings} />
      </div>
      {speedPreview && (
        <div className="confirm-routed-preview" aria-label="Speed change preview">
          {speedPreview.unavailableReason === null ? (
            <SpeedChangePreview
              key={speedPreview.mediaUrl ?? 'speed-preview'}
              effectiveSpeed={speedPreview.effectiveSpeed}
              mediaUrl={speedPreview.mediaUrl ?? ''}
              thumbnailUrl={speedPreview.thumbnailUrl}
            />
          ) : (
            <p className="confirm-routed-preview-fallback">
              {`Preview unavailable — ${speedPreview.unavailableReason}.`}
            </p>
          )}
        </div>
      )}
      {preview && <div className="confirm-routed-preview">{preview}</div>}
    </div>
  )
}

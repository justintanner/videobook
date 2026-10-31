import type { ReactNode } from 'react'
import type { RoutedActionSetting } from '@/videobook/chat-action-review'
import { PromptEcho, RoutedSettings } from './RoutedSettings'

export function RoutedBody({
  prompt,
  settings,
  preview = null,
  previewLayout = 'beside',
}: {
  prompt: string
  settings: readonly RoutedActionSetting[]
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
  const withPreview = Boolean(preview)
  const columns = withPreview ? 2 : Math.min(6, Math.max(1, settings.length))
  return (
    <div className={`confirm-routed${withPreview ? ' confirm-routed-with-preview' : ''}`}>
      <div className="confirm-routed-main">
        <PromptEcho prompt={prompt} />
        <RoutedSettings columns={columns} settings={settings} />
      </div>
      {preview && <div className="confirm-routed-preview">{preview}</div>}
    </div>
  )
}

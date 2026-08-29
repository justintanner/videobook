import type { RoutedActionSetting } from '@/videobook/chat-action-review'

// The user's own words, echoed above the settings the router derived from them.
export function PromptEcho({ prompt }: { prompt: string }) {
  if (!prompt.trim()) return null
  return (
    <p className="confirm-prompt-echo">
      <b aria-hidden="true">›</b>
      <span>{prompt}</span>
    </p>
  )
}

export function RoutedSettings({
  columns,
  settings,
}: {
  columns: number
  settings: readonly RoutedActionSetting[]
}) {
  return (
    <dl
      className="confirm-settings"
      aria-label="Action settings"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {settings.map((setting) => (
        <div
          key={setting.label}
          className={[
            setting.wide ? 'confirm-setting-wide' : '',
            setting.tone === 'warning' ? 'confirm-setting-warning' : '',
          ].join(' ').trim() || undefined}
        >
          <dt>{setting.label}</dt>
          <dd>{setting.value}</dd>
        </div>
      ))}
    </dl>
  )
}

import type { PostToolCall } from '@/videobook/use-post-actions'
import { useHarSettings } from '@/videobook/useHarSettings'

export function HarCaptureSettings({ call }: { call?: PostToolCall }) {
  const { settings, busy, error, update } = useHarSettings(call)
  return <section className="settings-section" aria-labelledby="settings-diagnostics-heading">
    <div className="settings-section-heading"><h2 id="settings-diagnostics-heading">Diagnostics</h2></div>
    <p className="settings-note">Provider request capture is off by default. Enabling it keeps prompts, media URLs, model parameters, provider responses and error text locally. Secrets, cookies and media bytes above the capture cap are not kept. Realtime WebSocket traffic is not captured.</p>
    <button type="button" disabled={busy || !call} onClick={() => void update()}>Check capture settings</button>
    {settings && <>
      <label htmlFor="har-capture-mode">Provider capture</label>
      <select id="har-capture-mode" value={settings.mode} disabled={busy || settings.overridden || !call}
        onChange={event => void update(event.target.value as 'off' | 'failures' | 'all')}>
        <option value="off">Off</option><option value="failures">Capture failed calls</option><option value="all">Capture all calls</option>
      </select>
      <p>Retained for up to {settings.maxAgeDays} days and {settings.maxTotalMB} MiB.</p>
      {settings.overridden && <p>Capture mode is controlled by the server environment.</p>}
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>
}

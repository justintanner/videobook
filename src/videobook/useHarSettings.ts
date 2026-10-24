import { useState } from 'react'
import type { PostToolCall } from './use-post-actions'

type HarMode = 'off' | 'failures' | 'all'
type HarSettings = { mode: HarMode; maxAgeDays: number; maxTotalMB: number; overridden: boolean }

export function useHarSettings(call?: PostToolCall) {
  const [settings, setSettings] = useState<HarSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function update(mode?: HarMode) {
    if (!call) return
    setBusy(true)
    setError(null)
    try {
      setSettings(await call('set_har_capture', mode ? { mode } : {}) as HarSettings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return { settings, busy, error, update }
}

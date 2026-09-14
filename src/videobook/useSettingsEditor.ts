import { useRef, useState } from 'react'
import { captureCommandComposerFocus } from './command-composer-focus'
import { settingLabel, type SettingsProvider } from './settings'

export function useSettingsEditor(onSave: (key: string, value: string) => Promise<void>) {
  const [draft, setDraft] = useState<{ key: string; value: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ key: string; text: string; error: boolean } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const epoch = useRef(0)

  const close = () => {
    epoch.current += 1
    setDraft(null)
    const target = opener.current
    captureCommandComposerFocus(() => target)()
  }

  const edit = (provider: SettingsProvider, target: HTMLElement) => {
    if (!provider.editable || saving) return
    epoch.current += 1
    opener.current = target
    setMessage(null)
    setDraft({ key: provider.envKey, value: provider.secret ? '' : provider.maskedKey ?? '' })
  }

  const save = async (provider: SettingsProvider) => {
    if (!draft || draft.key !== provider.envKey || !draft.value.trim() || saving || !provider.editable) return
    const request = epoch.current
    setSaving(true)
    setMessage(null)
    try {
      await onSave(draft.key, draft.value)
      if (request !== epoch.current) return
      setMessage({ key: draft.key, text: `${settingLabel(provider)} saved`, error: false })
      close()
    } catch (error) {
      if (request === epoch.current) setMessage({
        key: draft.key,
        text: error instanceof Error ? error.message : String(error),
        error: true,
      })
    } finally {
      setSaving(false)
    }
  }

  return {
    draft, saving, message, edit, close, save,
    change: (value: string) => setDraft(current => current ? { ...current, value } : null),
  }
}

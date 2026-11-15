import { useId } from 'react'
import { BUILTIN_SOUNDS, builtinSoundId } from '../../../server/src/sound-effects/catalog'
import { builtinSoundUrl } from '@/videobook/builtin-sound-preview'
import type { useVoicePreviewPlayer } from '@/videobook/voice-preview-player'

type BuiltinSoundFieldProps = {
  name: string
  label: string
  value: unknown
  required: boolean
  disabled: boolean
  preview: ReturnType<typeof useVoicePreviewPlayer>
  onChange: (value: unknown) => void
}

export function BuiltinSoundField({ name, label, value, required, disabled, preview, onChange }: BuiltinSoundFieldProps) {
  const id = useId()
  const soundId = typeof value === 'string' ? builtinSoundId(value) : null
  const sound = BUILTIN_SOUNDS.find((entry) => entry.id === soundId)
  const previewId = `${name}:${soundId}`
  const playing = preview.playingVoiceId === previewId

  return <div className="workspace-action-field workspace-action-sound">
    <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
    <div className="workspace-sound-preview">
      <select id={id} value={soundId ?? ''} required={required} disabled={disabled} aria-describedby={`${id}-description`}
        onChange={(event) => {
          preview.stop()
          onChange(event.target.value || undefined)
        }}>
        <option value="">{required ? 'Choose sound' : 'Use default'}</option>
        {BUILTIN_SOUNDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
      </select>
      <button type="button" disabled={disabled || !sound} aria-pressed={playing}
        aria-label={`${playing ? 'Stop' : 'Preview'} ${sound?.title ?? 'sound'}`}
        onClick={() => { if (sound) preview.toggle(previewId, builtinSoundUrl(sound.id)) }}>
        {playing ? 'Stop' : 'Preview'}
      </button>
    </div>
    <p id={`${id}-description`} className="workspace-action-hint">{sound?.description ?? 'Choose a sound to hear a preview.'}</p>
  </div>
}

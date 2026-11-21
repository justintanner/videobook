import windowsShutdownUrl from '../../server/src/sound-effects/recordings/windows_shutdown.mp3'
import { isRecordedSound, type BuiltinSoundId, type RecordedSoundId } from '../../server/src/sound-effects/catalog'
import { renderBuiltinSound } from '../../server/src/sound-effects/synth'
import { encodeWav } from '../../server/src/sound-effects/wav'

const RECORDING_URLS: Record<RecordedSoundId, string> = {
  shutdown: windowsShutdownUrl,
}

const urls = new Map<BuiltinSoundId, string>()

export function builtinSoundUrl(id: BuiltinSoundId): string {
  if (isRecordedSound(id)) return RECORDING_URLS[id]
  const cached = urls.get(id)
  if (cached) return cached
  const bytes = new Uint8Array(encodeWav(renderBuiltinSound(id)))
  const url = URL.createObjectURL(new Blob([bytes.buffer], { type: 'audio/wav' }))
  urls.set(id, url)
  return url
}

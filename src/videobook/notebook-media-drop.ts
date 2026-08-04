export type PassiveMediaKind = 'audio' | 'image' | 'video'

const mediaFileExtensions: Record<PassiveMediaKind, ReadonlySet<string>> = {
  audio: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'weba']),
  image: new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']),
  video: new Set(['avi', 'mkv', 'mov', 'mp4', 'webm']),
}

export const mediaFileAccept: Record<PassiveMediaKind, string> = {
  audio: 'audio/*,.aac,.flac,.m4a,.mp3,.ogg,.wav,.weba',
  image: 'image/*,.gif,.jpeg,.jpg,.png,.svg,.webp',
  video: 'video/*,.avi,.mkv,.mov,.mp4,.webm',
}

export function mediaKindForFile(
  file: Pick<File, 'name' | 'type'>,
): PassiveMediaKind | null {
  const mimeKind = file.type.split('/', 1)[0]
  if (mimeKind === 'audio' || mimeKind === 'image' || mimeKind === 'video') {
    return mimeKind
  }
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  for (const kind of ['audio', 'image', 'video'] as const) {
    if (mediaFileExtensions[kind].has(extension)) return kind
  }
  return null
}

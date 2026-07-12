import type { ManifestFile } from './viewer-types'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a)$/i

/** Split manifest files into image / audio / other buckets by filename. */
export function categorizeManifestFiles(files: ManifestFile[]): {
  images: ManifestFile[]
  audio: ManifestFile[]
  others: ManifestFile[]
} {
  const images: ManifestFile[] = []
  const audio: ManifestFile[] = []
  const others: ManifestFile[] = []
  for (const f of files) {
    if (IMAGE_EXT.test(f.name)) images.push(f)
    else if (AUDIO_EXT.test(f.name)) audio.push(f)
    else others.push(f)
  }
  return { images, audio, others }
}

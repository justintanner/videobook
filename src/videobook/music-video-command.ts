type MusicVideoCommandAsset = {
  id: string
  artifactId: string
  label: string
  type: string
  status: string
  mediaUrl: string | null
  audioInfo: unknown | null
}

type MusicVideoCommandResolution<Asset extends MusicVideoCommandAsset> =
  | { ok: true; asset: Asset }
  | { ok: false; message: string }

export function resolveMusicVideoCommandAsset<Asset extends MusicVideoCommandAsset>(
  reference: string | null,
  assets: readonly Asset[],
): MusicVideoCommandResolution<Asset> {
  const asset = reference
    ? assets.find((candidate) =>
        candidate.artifactId === reference || candidate.id === reference)
    : undefined
  if (!reference || !asset) {
    return { ok: false, message: 'Usage: /music-video @audio' }
  }
  if (asset.type !== 'audio') {
    return { ok: false, message: '/music-video requires an audio asset' }
  }
  if (asset.status !== 'ready' || !asset.mediaUrl || !asset.audioInfo) {
    return {
      ok: false,
      message: 'Process the audio asset before opening the music-video editor',
    }
  }
  return { ok: true, asset }
}

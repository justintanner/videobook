import type { AssetRecord } from '@/videobook/workspace-responses'

type AssetResolver = (artifactId: string) => AssetRecord | null

export function GoalMedia({ artifactId, cellId, label, resolveAsset, onOpen, fullResolution = false }: {
  artifactId: string
  cellId: string | null
  label: string
  resolveAsset: AssetResolver
  onOpen: (cellId: string) => void
  fullResolution?: boolean
}) {
  const asset = resolveAsset(artifactId)
  const url = fullResolution ? asset?.mediaUrl ?? asset?.thumbnailUrl : asset?.thumbnailUrl ?? asset?.mediaUrl
  return <button type="button" className="goal-media" disabled={!cellId} onClick={() => { if (cellId) onOpen(cellId) }} aria-label={`Open ${label}`}>
    {url ? <img src={url} alt={label} /> : <span className="goal-media-pending">Preview pending</span>}
    <span>{label}</span>
  </button>
}

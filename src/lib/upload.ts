export interface UploadResult {
  assetId: string
  path: string
  filename: string
}

export async function uploadProjectFile(
  projectSlug: string,
  data: Blob,
  filename: string,
  targetAssetId?: string,
): Promise<UploadResult> {
  const url = new URL(`/api/upload/${encodeURIComponent(projectSlug)}`, window.location.origin)
  url.searchParams.set('filename', filename)
  if (targetAssetId) {
    url.searchParams.set('targetAssetId', targetAssetId)
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  })

  if (!response.ok) {
    const message = await readUploadError(response)
    throw new Error(message)
  }

  return await response.json() as UploadResult
}

async function readUploadError(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `Upload failed with status ${response.status}`

  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
  } catch {
    return text
  }

  return text
}

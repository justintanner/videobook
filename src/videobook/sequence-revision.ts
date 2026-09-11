import type { Sequence } from 'videobook-engine'

export async function sequenceContentRevision(sequence: Sequence): Promise<string> {
  const { revision: _revision, ...content } = sequence
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(content)),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

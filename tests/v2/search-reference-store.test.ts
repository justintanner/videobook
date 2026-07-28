import { describe, expect, it } from 'vitest'
import { SearchReferenceStore } from '../../server/src/search-reference-store.js'

function imageReference(value: number) {
  return {
    kind: 'image' as const,
    embeddingSpace: 'fixture-space',
    vector: [value],
  }
}

describe('temporary search reference store', () => {
  it('expires, releases, and bounds prepared references', () => {
    let now = 1_000
    const store = new SearchReferenceStore(100, 2, () => now)
    const first = store.put({
      kind: 'image',
      name: 'first.png',
      reference: imageReference(1),
    })
    expect(store.get(first.reference_id).reference).toEqual(imageReference(1))
    expect(store.release(first.reference_id)).toBe(true)
    expect(() => store.get(first.reference_id)).toThrow('expired or was released')

    const second = store.put({
      kind: 'image',
      name: 'second.png',
      reference: imageReference(2),
    })
    store.put({
      kind: 'image',
      name: 'third.png',
      reference: imageReference(3),
    })
    store.put({
      kind: 'image',
      name: 'fourth.png',
      reference: imageReference(4),
    })
    expect(() => store.get(second.reference_id)).toThrow('expired or was released')

    const expiring = store.put({
      kind: 'image',
      name: 'expiring.png',
      reference: imageReference(5),
    })
    now = expiring.expires_at
    expect(() => store.get(expiring.reference_id)).toThrow('expired or was released')
  })
})

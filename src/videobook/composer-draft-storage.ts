const STORAGE_KEY = 'videobook.composer-drafts.v1'
const MAX_DRAFTS = 50
const MAX_CHARACTERS = 1_000_000

function storedEntries(values: readonly unknown[]): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  const seen = new Set<string>()
  let characters = 0
  for (const value of [...values].reverse()) {
    if (!Array.isArray(value) || value.length !== 2) continue
    const [session, draft] = value as unknown[]
    if (typeof session !== 'string' || !session.startsWith('chat:')
      || session.length <= 5 || session.length > 128 || seen.has(session)) continue
    seen.add(session)
    if (typeof draft !== 'string' || !draft || characters + draft.length > MAX_CHARACTERS) continue
    entries.push([session, draft])
    characters += draft.length
    if (entries.length === MAX_DRAFTS) break
  }
  return entries.reverse()
}

export function readComposerDrafts(): ReadonlyMap<string | null, string> {
  if (typeof window === 'undefined') return new Map()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw || raw.length > MAX_CHARACTERS * 6 + 10_000) return new Map()
    const values: unknown = JSON.parse(raw)
    return new Map(Array.isArray(values) ? storedEntries(values) : [])
  } catch {
    return new Map()
  }
}

export function saveComposerDrafts(
  drafts: ReadonlyMap<string | null, string>,
  session: string | null,
  input: string,
): void {
  if (typeof window === 'undefined') return
  const next = new Map(drafts)
  next.delete(session)
  next.set(session, input)
  const entries = storedEntries([...next])
  try {
    if (entries.length === 0) window.sessionStorage.removeItem(STORAGE_KEY)
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      return
    }
  }
}

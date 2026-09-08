/**
 * Client half of `forget_asset`: the tool destroys an asset's stored bytes, so
 * the UI has to say plainly what still holds it and what was reclaimed.
 */
export type ForgetAssetReference = {
  kind: string
  id: string
}

export type ForgetAssetOutcome = {
  status: 'forgotten' | 'in_use'
  artifactId: string
  label: string | null
  references: ForgetAssetReference[]
  clearedCells: number
  forgottenObjects: number
  sharedObjects: number
  reclaimedBytes: number
}

/** Engine reference kinds, singular and plural, in the order we report them. */
const REFERENCE_LABELS: ReadonlyArray<{
  kind: string
  one: string
  many: string
}> = [
  { kind: 'cell.outputArtifact', one: 'notebook cell', many: 'notebook cells' },
  { kind: 'cell.reference', one: 'cell reference', many: 'cell references' },
  { kind: 'sequenceClip', one: 'sequence clip', many: 'sequence clips' },
  { kind: 'pinnedSearchResult', one: 'pinned result', many: 'pinned results' },
  { kind: 'stream', one: 'media stream', many: 'media streams' },
  { kind: 'transcript', one: 'transcript', many: 'transcripts' },
  { kind: 'captionCue', one: 'caption cue', many: 'caption cues' },
]

function countLabel(kind: string, count: number): string {
  const label = REFERENCE_LABELS.find((entry) => entry.kind === kind)
  if (!label) return `${count} ${kind}`
  return `${count} ${count === 1 ? label.one : label.many}`
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? ''
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

/** "2 notebook cells and 1 sequence clip" — what still holds the asset. */
export function forgetReferenceSummary(
  references: readonly ForgetAssetReference[],
): string {
  const counts = new Map<string, number>()
  for (const reference of references) {
    counts.set(reference.kind, (counts.get(reference.kind) ?? 0) + 1)
  }
  const ordered = [
    ...REFERENCE_LABELS
      .filter((entry) => counts.has(entry.kind))
      .map((entry) => entry.kind),
    ...[...counts.keys()].filter((kind) =>
      !REFERENCE_LABELS.some((entry) => entry.kind === kind)),
  ]
  const phrases = ordered.map((kind) => countLabel(kind, counts.get(kind) ?? 0))
  return phrases.length > 0 ? joinPhrases(phrases) : 'something else in this book'
}

export function formatReclaimedBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  )
  const value = bytes / 1024 ** exponent
  const rounded = exponent === 0 || value >= 100
    ? Math.round(value)
    : Math.round(value * 10) / 10
  return `${rounded} ${units[exponent]}`
}

/** What to tell the user after the content is gone. */
export function forgottenNotice(
  name: string,
  outcome: ForgetAssetOutcome,
): string {
  const parts = [
    outcome.reclaimedBytes > 0
      ? `${formatReclaimedBytes(outcome.reclaimedBytes)} reclaimed`
      : '',
    outcome.sharedObjects > 0
      ? `${outcome.sharedObjects} file${outcome.sharedObjects === 1 ? '' : 's'} kept for another asset`
      : '',
    outcome.clearedCells > 0
      ? `cleared ${outcome.clearedCells} cell${outcome.clearedCells === 1 ? '' : 's'}`
      : '',
  ].filter((part) => part !== '')
  return parts.length > 0
    ? `Forgot ${name} · ${parts.join(' · ')}`
    : `Forgot ${name}`
}

/** Confirmation copy: destructive, irreversible, and specific about it. */
export function forgetConfirmation(name: string): string {
  return `Forget ${name}?\n\n`
    + 'This deletes the asset and destroys its stored content. '
    + 'Files shared with another asset are kept. This cannot be undone.'
}

export function clearReferencesConfirmation(
  name: string,
  references: readonly ForgetAssetReference[],
): string {
  return `${name} is still used by ${forgetReferenceSummary(references)}.\n\n`
    + 'Clear those references and forget it anyway?'
}

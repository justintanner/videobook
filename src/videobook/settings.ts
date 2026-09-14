export interface SettingsProvider {
  envKey: string
  provider: string
  label: string
  keyStatus: string
  maskedKey: string | null
  editable: boolean
  secret: boolean
  source: string
}

interface SettingsStorageValue {
  state: string
  head: string
  pendingObjects: number
  lastError?: string
}

export type SettingsStorageSnapshot =
  | { bookId: string; status: 'loading' }
  | { bookId: string; status: 'ready'; value: SettingsStorageValue }
  | { bookId: string; status: 'error'; error: string }

const settingLabels: Readonly<Record<string, string>> = {
  X_CLIENT_ID: 'X client ID',
  X_CLIENT_SECRET: 'X client secret',
  B2_ACCESS_KEY_ID: 'Access key ID',
  B2_SECRET_ACCESS_KEY: 'Secret access key',
  B2_REGION: 'Region',
  B2_BUCKET: 'Bucket',
  B2_ENDPOINT: 'Endpoint',
  B2_ARCHIVE_PREFIX: 'Archive prefix',
}

export function settingLabel(provider: SettingsProvider): string {
  return settingLabels[provider.envKey] ?? provider.label
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseSettingsProviders(value: unknown): SettingsProvider[] {
  const data = objectValue(value)
  if (!Array.isArray(data?.providers)) throw new Error('Could not read provider settings')
  return data.providers.flatMap(entry => {
    const provider = objectValue(entry)
    if (!provider || typeof provider.envKey !== 'string'
      || typeof provider.label !== 'string' || typeof provider.provider !== 'string') return []
    return [{
      envKey: provider.envKey,
      provider: provider.provider,
      label: provider.label,
      keyStatus: typeof provider.keyStatus === 'string' ? provider.keyStatus : 'missing',
      maskedKey: typeof provider.maskedKey === 'string' ? provider.maskedKey : null,
      editable: provider.editable === true && provider.source !== '1password',
      secret: provider.secret !== false,
      source: typeof provider.source === 'string' ? provider.source : 'missing',
    }]
  })
}

export function parseSettingsStorage(value: unknown): SettingsStorageValue {
  const data = objectValue(value)
  if (!data || typeof data.state !== 'string' || typeof data.head !== 'string'
    || typeof data.pendingObjects !== 'number' || !Number.isSafeInteger(data.pendingObjects)
    || data.pendingObjects < 0) throw new Error('Could not read project storage status')
  return {
    ...data,
    state: data.state,
    head: data.head,
    pendingObjects: data.pendingObjects,
    ...(typeof data.lastError === 'string' ? { lastError: data.lastError } : {}),
  }
}

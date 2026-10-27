import type { ReactNode } from 'react'
import { HarCaptureSettings } from './HarCaptureSettings'
import type { PostToolCall } from '@/videobook/use-post-actions'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { SCHEMA_VERSION } from 'videobook-engine/catalog-metadata'
import enginePackage from 'videobook-engine/package.json'
import { settingLabel, type SettingsProvider, type SettingsStorageSnapshot } from '@/videobook/settings'
import { useSettingsEditor } from '@/videobook/useSettingsEditor'
import type { XConnectionState } from '@/videobook/x-connection'
import { XConnectionCard } from './XConnectionCard'
import './SettingsScreen.css'

interface SettingsScreenProps {
  call?: PostToolCall
  providers: readonly SettingsProvider[]
  loading: boolean
  error: string | null
  refreshed: boolean
  storage: SettingsStorageSnapshot | null
  bookId: string
  bookName: string | null
  connection: XConnectionState
  busy: boolean
  onRefresh: () => Promise<void>
  onSave: (key: string, value: string) => Promise<void>
  onConnect: () => void
}

type SettingsEditor = ReturnType<typeof useSettingsEditor>

const APPLICATION_PROVIDERS = ['x', 'b2']

function statusLabel(keyStatus: string): string {
  if (keyStatus === 'configured') return 'Set'
  if (keyStatus === 'placeholder') return 'Placeholder'
  return 'Missing'
}

function credentialDetail(provider: SettingsProvider): string {
  const source = provider.source === '1password' ? 'Managed in 1Password' : provider.editable ? null : 'Read only'
  return [provider.maskedKey, source].filter(Boolean).join(' · ') || 'Not set'
}

function editLabel(provider: SettingsProvider): string {
  if (provider.keyStatus === 'configured') return 'Edit'
  return provider.secret ? 'Set key' : 'Set value'
}

function KeyEditor({ provider, editor, busy }: { provider: SettingsProvider; editor: SettingsEditor; busy: boolean }) {
  const label = settingLabel(provider)
  return <form className="settings-key-editor" aria-label={`Edit ${label}`}
    onSubmit={event => { event.preventDefault(); void editor.save(provider) }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || editor.saving) return
      event.preventDefault()
      event.stopPropagation()
      editor.close()
    }}>
    <label className="settings-visually-hidden" htmlFor={`setting-${provider.envKey}`}>{label}</label>
    <input id={`setting-${provider.envKey}`} autoFocus type={provider.secret ? 'password' : 'text'}
      value={editor.draft?.value ?? ''} autoComplete="off" spellCheck={false}
      placeholder={provider.envKey} disabled={busy || editor.saving}
      onChange={event => editor.change(event.target.value)} />
    <button type="submit" className="settings-primary" disabled={busy || editor.saving || !editor.draft?.value.trim()}>
      {editor.saving ? 'Saving…' : 'Save'}
    </button>
    <button type="button" disabled={editor.saving} onClick={editor.close}>Cancel</button>
  </form>
}

function CredentialRow({ provider, editor, busy }: { provider: SettingsProvider; editor: SettingsEditor; busy: boolean }) {
  const label = settingLabel(provider)
  const editing = editor.draft?.key === provider.envKey && provider.editable
  const message = editor.message?.key === provider.envKey ? editor.message : null
  return <article className="settings-credential settings-row" aria-label={`${label} setting`}>
    <div className="settings-row-main">
      <div className="settings-row-copy">
        <strong>{label}</strong>
        <span className="settings-row-detail">{credentialDetail(provider)}</span>
      </div>
      <span className={`settings-status settings-key-${provider.keyStatus}`}>{statusLabel(provider.keyStatus)}</span>
      {provider.editable ? <button type="button" className="settings-quiet" aria-label={`Edit ${label}`}
        aria-expanded={editing} disabled={busy || editor.saving}
        onClick={event => editor.edit(provider, event.currentTarget)}>
        <span className="settings-edit-text">{editLabel(provider)}</span>
        <ChevronRight className="settings-edit-chevron" size={16} aria-hidden="true" />
      </button>
        : <span className="settings-row-spacer" />}
    </div>
    {editing && <KeyEditor provider={provider} editor={editor} busy={busy} />}
    {message && <p className={message.error ? 'settings-error' : 'settings-feedback'}
      role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </article>
}

function CredentialRows({ providers, editor, busy }: {
  providers: readonly SettingsProvider[]
  editor: SettingsEditor
  busy: boolean
}) {
  return <div className="settings-credentials settings-list">
    {providers.map(provider => <CredentialRow key={provider.envKey} provider={provider} editor={editor} busy={busy} />)}
  </div>
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return <details className="settings-details">
    <summary><ChevronRight size={14} aria-hidden="true" />{summary}</summary>
    <div className="settings-details-body">{children}</div>
  </details>
}

const SECTION_LINKS = [
  { id: 'settings-providers-heading', label: 'Providers' },
  { id: 'settings-accounts-heading', label: 'Accounts' },
  { id: 'settings-storage-heading', label: 'Storage' },
  { id: 'settings-diagnostics-heading', label: 'Diagnostics' },
] as const

function jumpToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function SectionJump() {
  return <nav className="settings-jump" aria-label="Settings sections">
    {SECTION_LINKS.map(link => <button key={link.id} type="button" onClick={() => jumpToSection(link.id)}>{link.label}</button>)}
  </nav>
}

function configuredCount(providers: readonly SettingsProvider[]): string {
  const configured = providers.filter(provider => provider.keyStatus === 'configured').length
  return `${configured} of ${providers.length} set`
}

function StorageStatus({ storage, bookId, loading }: {
  storage: SettingsStorageSnapshot | null
  bookId: string
  loading: boolean
}) {
  const current = storage?.bookId === bookId ? storage : null
  if (!bookId) return <p className="settings-note">Select a project to inspect its storage.</p>
  if (current?.status === 'error') return <p role="alert" className="settings-error">{current.error}</p>
  if (current?.status !== 'ready') return <p className="settings-note" role="status">{loading ? 'Loading storage…' : 'Refresh to inspect storage.'}</p>
  const stored = current.value
  return <>
    <dl className="settings-storage-summary settings-list">
      <div className="settings-row"><dt>Backup</dt><dd>{stored.state.replaceAll('_', ' ')}</dd></div>
      <div className="settings-row"><dt>Pending objects</dt><dd>{stored.pendingObjects}</dd></div>
    </dl>
    {stored.lastError && <p role="alert" className="settings-error">{stored.lastError}</p>}
    <Disclosure summary="Technical details"><pre>{JSON.stringify(stored, null, 2)}</pre></Disclosure>
  </>
}

export function SettingsScreen({ call, providers, loading, error, refreshed, storage, bookId, bookName,
  connection, busy, onRefresh, onSave, onConnect }: SettingsScreenProps) {
  const editor = useSettingsEditor(onSave)
  const aiProviders = providers.filter(provider => !APPLICATION_PROVIDERS.includes(provider.provider))
  const accountCredentials = providers.filter(provider => provider.provider === 'x')
  const storageCredentials = providers.filter(provider => provider.provider === 'b2')

  return <section className="workspace-screen settings-screen" aria-label="Settings">
    <div className="settings-page">
      <header>
        <div>
          <h1>Settings</h1>
          <p>API keys, accounts and storage. Keys are saved on this computer.</p>
        </div>
        <div className="settings-refresh">
          <span role="status">{loading ? 'Refreshing…' : refreshed ? 'Up to date' : ''}</span>
          <button type="button" disabled={busy || loading} onClick={() => void onRefresh()}>
            <RefreshCw size={15} aria-hidden="true" /><span className="settings-refresh-label">Refresh</span>
          </button>
        </div>
      </header>
      {error && <p role="alert" className="settings-error">{error}</p>}

      <SectionJump />

      <div className="settings-columns">
        <div className="settings-column">
          <section className="settings-section settings-providers" aria-labelledby="settings-providers-heading">
            <div className="settings-section-heading">
              <h2 id="settings-providers-heading">AI providers</h2>
              {aiProviders.length > 0 && <span>{configuredCount(aiProviders)}</span>}
            </div>
            {aiProviders.length ? <CredentialRows providers={aiProviders} editor={editor} busy={busy} />
              : <p className="settings-note">{loading ? 'Loading providers…' : 'Refresh to load provider settings.'}</p>}
          </section>
        </div>
        <div className="settings-column">
          <section className="settings-section" aria-labelledby="settings-accounts-heading">
            <div className="settings-section-heading"><h2 id="settings-accounts-heading">Accounts</h2></div>
            <div className="settings-list">
              <XConnectionCard busy={busy} connection={connection} onConnect={onConnect} />
            </div>
            <Disclosure summary="App credentials">
              <CredentialRows providers={accountCredentials} editor={editor} busy={busy} />
            </Disclosure>
          </section>

          <section className="settings-section" aria-labelledby="settings-storage-heading">
            <div className="settings-section-heading">
              <h2 id="settings-storage-heading">Storage</h2>
              <span>{bookName ?? 'No project selected'}</span>
            </div>
            <StorageStatus storage={storage} bookId={bookId} loading={loading} />
            <Disclosure summary="Backblaze configuration">
              <p className="settings-note">Shared by all projects.</p>
              <CredentialRows providers={storageCredentials} editor={editor} busy={busy} />
            </Disclosure>
          </section>

          <HarCaptureSettings call={call} />
        </div>
      </div>

      <p className="settings-version">videobook-engine {enginePackage.version} · schema {SCHEMA_VERSION}</p>
    </div>
  </section>
}

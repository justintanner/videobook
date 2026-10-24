import { HarCaptureSettings } from './HarCaptureSettings'
import { DropboxConnectionCard } from './DropboxConnectionCard'
import type { PostToolCall } from '@/videobook/use-post-actions'
import { RefreshCw } from 'lucide-react'
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

function CredentialRows({ providers, editor, busy }: {
  providers: readonly SettingsProvider[]
  editor: SettingsEditor
  busy: boolean
}) {
  return <div className="settings-credentials">
    {providers.map(provider => {
      const label = settingLabel(provider)
      const editing = editor.draft?.key === provider.envKey && provider.editable
      const message = editor.message?.key === provider.envKey ? editor.message : null
      return <article className="settings-credential" key={provider.envKey} aria-label={`${label} setting`}>
        <div className="settings-credential-summary">
          <span className={`settings-key-status settings-key-${provider.keyStatus}`} aria-hidden="true" />
          <div className="settings-credential-copy">
            <strong>{label}</strong>
            <span className="settings-key-caption">{provider.keyStatus === 'configured' ? 'Configured'
              : provider.keyStatus === 'placeholder' ? 'Placeholder key' : 'Not configured'}</span>
            {provider.maskedKey && <span className="settings-key-value">{provider.maskedKey}</span>}
            {!provider.editable && <span className="settings-key-source">{provider.source === '1password'
              ? 'Managed in 1Password' : 'Read only'}</span>}
          </div>
          {provider.editable && <button type="button" aria-label={`Edit ${label}`} aria-expanded={editing}
            disabled={busy || editor.saving} onClick={event => editor.edit(provider, event.currentTarget)}>
            {provider.keyStatus === 'configured' ? 'Edit' : provider.secret ? 'Set key' : 'Set value'}
          </button>}
        </div>
        {editing && <form className="settings-key-editor" aria-label={`Edit ${label}`}
          onSubmit={event => { event.preventDefault(); void editor.save(provider) }}
          onKeyDown={event => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing || editor.saving) return
            event.preventDefault()
            event.stopPropagation()
            editor.close()
          }}>
          <label htmlFor={`setting-${provider.envKey}`}>{label}</label>
          <input id={`setting-${provider.envKey}`} autoFocus type={provider.secret ? 'password' : 'text'}
            value={editor.draft?.value ?? ''} autoComplete="off" spellCheck={false}
            disabled={busy || editor.saving} onChange={event => editor.change(event.target.value)} />
          <small>{provider.envKey} · Saved locally</small>
          <div className="settings-key-actions">
            <button type="submit" disabled={busy || editor.saving || !editor.draft?.value.trim()}>
              {editor.saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" disabled={editor.saving} onClick={editor.close}>Cancel</button>
          </div>
        </form>}
        {message && <p className={message.error ? 'settings-error' : 'settings-feedback'}
          role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      </article>
    })}
  </div>
}

function configurationSummary(providers: readonly SettingsProvider[]): string {
  const configured = providers.filter(provider => provider.keyStatus === 'configured').length
  return `${configured} of ${providers.length} configured`
}

export function SettingsScreen({ call, providers, loading, error, refreshed, storage, bookId, bookName,
  connection, busy, onRefresh, onSave, onConnect }: SettingsScreenProps) {
  const editor = useSettingsEditor(onSave)
  const mainProviders = providers.filter(provider => !['x', 'b2', 'dropbox'].includes(provider.provider))
  const dropboxCredentials = providers.filter(provider => provider.provider === 'dropbox')
  const xCredentials = providers.filter(provider => provider.provider === 'x')
  const storageCredentials = providers.filter(provider => provider.provider === 'b2')
  const currentStorage = storage?.bookId === bookId ? storage : null
  const stored = currentStorage?.status === 'ready' ? currentStorage.value : null

  return <section className="workspace-screen settings-screen" aria-label="Settings">
    <header>
      <div><h1>Settings</h1><p>Providers, connected accounts and project storage.</p></div>
      <div className="settings-refresh">
        <span role="status">{loading ? 'Refreshing…' : refreshed ? 'Up to date' : ''}</span>
        <button type="button" disabled={busy || loading} onClick={() => void onRefresh()}>
          <RefreshCw size={15} aria-hidden="true" />Refresh
        </button>
      </div>
    </header>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="settings-layout">
      <section className="settings-panel settings-providers" aria-labelledby="settings-providers-heading">
        <div className="settings-panel-heading"><h2 id="settings-providers-heading">Providers</h2><span>Application</span></div>
        <p className="settings-section-summary">{mainProviders.length ? configurationSummary(mainProviders) : loading ? 'Loading providers…' : 'Refresh to load provider settings.'}</p>
        <CredentialRows providers={mainProviders} editor={editor} busy={busy} />
      </section>
      <div className="settings-secondary">
        <HarCaptureSettings call={call} />
        <section className="settings-panel" aria-labelledby="settings-x-heading">
          <div className="settings-panel-heading"><h2 id="settings-x-heading">X account</h2><span>Application</span></div>
          <XConnectionCard busy={busy} connection={connection} onConnect={onConnect} />
          <details className="settings-details">
            <summary>X credentials <span>{configurationSummary(xCredentials)}</span></summary>
            <CredentialRows providers={xCredentials} editor={editor} busy={busy} />
          </details>
        </section>
        <section className="settings-panel" aria-labelledby="settings-dropbox-heading">
          <div className="settings-panel-heading"><h2 id="settings-dropbox-heading">Dropbox</h2><span>Application</span></div>
          <DropboxConnectionCard call={call} />
          <details className="settings-details"><summary>Dropbox credentials</summary><CredentialRows providers={dropboxCredentials} editor={editor} busy={busy} /></details>
        </section>
        <section className="settings-panel" aria-labelledby="settings-storage-heading">
          <div className="settings-panel-heading"><h2 id="settings-storage-heading">Storage</h2><span>Selected project</span></div>
          <p className="settings-section-summary">{bookName ?? 'No project selected'}</p>
          {!bookId ? <p>Select a project to inspect its storage.</p>
            : currentStorage?.status === 'error' ? <p role="alert" className="settings-error">{currentStorage.error}</p>
            : !stored ? <p role="status">{loading ? 'Loading storage…' : 'Refresh to inspect storage.'}</p>
            : <>
              <dl className="settings-storage-summary">
                <div><dt>Backup</dt><dd>{stored.state.replaceAll('_', ' ')}</dd></div>
                <div><dt>Pending objects</dt><dd>{stored.pendingObjects}</dd></div>
              </dl>
              {stored.lastError && <p role="alert" className="settings-error">{stored.lastError}</p>}
              <details className="settings-details">
                <summary>Technical details</summary>
                <p>videobook-engine {enginePackage.version} · schema {SCHEMA_VERSION}</p>
                <pre>{JSON.stringify(stored, null, 2)}</pre>
              </details>
            </>}
          <details className="settings-details">
            <summary>Backblaze configuration <span>{configurationSummary(storageCredentials)}</span></summary>
            <p>Application · shared by all projects.</p>
            <CredentialRows providers={storageCredentials} editor={editor} busy={busy} />
          </details>
        </section>
      </div>
    </div>
  </section>
}

import { useState } from 'react';
import { RefreshCw, ShieldCheck, AlertTriangle, Lock, Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CloseButton } from '@/components/ui/CloseButton';
import type { ProviderKeyInfo, ProviderKeySource, ProviderKeyStatusResponse } from '@/hooks/useProviderKeyStatus';

interface ProviderKeysScreenProps {
  data: ProviderKeyStatusResponse | null;
  loading: boolean;
  error: string | null;
  saving: string | null;
  saveError: string | null;
  onSave: (key: string, value: string) => Promise<boolean>;
  onRefresh: () => void;
  onClose: () => void;
}

const GRID_COLS = 'grid-cols-[0.6fr_0.95fr_0.55fr_1.3fr_0.42fr_0.42fr_0.76fr]';

function label(value: string): string {
  return value.replaceAll('_', ' ').toUpperCase();
}

function formatCredits(provider: ProviderKeyInfo): string {
  if (provider.credits.value === null) return 'N/A';
  return provider.credits.value.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatTokens(provider: ProviderKeyInfo): string {
  if (provider.tokenLookup.value === null) return 'N/A';
  return provider.tokenLookup.value.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatFetchedAt(value: string | null): string {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function keyDisplay(provider: ProviderKeyInfo): string {
  return provider.maskedKey ?? label(provider.keyStatus);
}

function checkedAt(provider: ProviderKeyInfo): string | null {
  return provider.credits.fetchedAt ?? provider.tokenLookup.fetchedAt;
}

function statusTitle(provider: ProviderKeyInfo): string | undefined {
  if (provider.tokenLookup.status === 'ok') return provider.tokenLookup.model ?? undefined;
  if (provider.tokenLookup.status === 'error') return provider.tokenLookup.message ?? undefined;
  if (provider.credits.status === 'ok' || provider.credits.status === 'error') return provider.credits.message ?? undefined;
  return provider.tokenLookup.message ?? provider.credits.message ?? undefined;
}

function SourceBadge({ source }: { source: ProviderKeySource }) {
  if (source === '1password') {
    return (
      <span
        className="inline-flex items-center gap-1 font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground"
        title="Managed in the 1Password vault — read-only here"
      >
        <Lock className="w-3 h-3 shrink-0" />
        1PASSWORD
      </span>
    );
  }
  if (source === 'env') {
    return (
      <span
        className="inline-flex items-center gap-1 font-mono text-[10px] font-bold tracking-[0.18em] text-primary"
        title="Stored in .env — editable"
      >
        <Pencil className="w-3 h-3 shrink-0" />
        .ENV
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[10px] font-bold tracking-[0.18em] text-amber-400"
      title="Not configured — set a value to store it in .env"
    >
      <AlertTriangle className="w-3 h-3 shrink-0" />
      MISSING
    </span>
  );
}

interface ProviderRowProps {
  provider: ProviderKeyInfo;
  saving: string | null;
  onSave: (key: string, value: string) => Promise<boolean>;
}

function ProviderRow({ provider, saving, onSave }: ProviderRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isSaving = saving === provider.envKey;

  const startEdit = () => {
    setDraft(provider.secret ? '' : (provider.maskedKey ?? ''));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft('');
  };

  const save = async () => {
    if (draft.trim() === '') return;
    const ok = await onSave(provider.envKey, draft);
    if (ok) {
      setEditing(false);
      setDraft('');
    }
  };

  return (
    <div className={`grid ${GRID_COLS} gap-3 items-center px-3 py-3 border-t border-border/60`}>
      <div className="min-w-0">
        <div className="font-mono text-sm font-bold text-foreground truncate">{provider.label}</div>
      </div>

      <div className="min-w-0">
        <div className="font-mono text-xs text-zinc-200 truncate">{provider.envKey}</div>
      </div>

      <div className="min-w-0">
        <SourceBadge source={provider.source} />
      </div>

      <div className="min-w-0 flex items-center gap-1.5">
        {editing ? (
          <>
            <input
              autoFocus
              type={provider.secret ? 'password' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') cancelEdit();
              }}
              placeholder="new value"
              disabled={isSaving}
              className="h-8 w-full min-w-0 rounded border border-primary/50 bg-black/40 px-2 font-mono text-xs text-zinc-200 shadow-sm focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              aria-label={`New value for ${provider.envKey}`}
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={isSaving || draft.trim() === ''}
              className="h-8 w-8 shrink-0 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center"
              title={`Save ${provider.envKey} to .env`}
            >
              {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={isSaving}
              className="h-8 w-8 shrink-0 rounded border border-border bg-black/40 text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors inline-flex items-center justify-center"
              title="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <>
            <input
              readOnly
              value={keyDisplay(provider)}
              className="h-8 w-full min-w-0 rounded border border-input bg-black/40 px-2 font-mono text-xs text-zinc-200 shadow-sm truncate focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`${provider.label} API key`}
            />
            {provider.editable && (
              <button
                type="button"
                onClick={startEdit}
                className="h-8 w-8 shrink-0 rounded border border-border bg-black/40 text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors inline-flex items-center justify-center"
                title={`Edit ${provider.envKey}`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
      </div>

      <div className="min-w-0">
        <div className="font-mono text-base font-bold tabular-nums text-foreground truncate" title={provider.credits.message ?? undefined}>
          {formatCredits(provider)}
        </div>
      </div>

      <div className="min-w-0">
        <div className="font-mono text-base font-bold tabular-nums text-foreground truncate" title={provider.tokenLookup.model ?? provider.tokenLookup.message ?? undefined}>
          {formatTokens(provider)}
        </div>
      </div>

      <div className="min-w-0">
        <span className="font-mono text-xs text-muted-foreground whitespace-nowrap truncate block" title={statusTitle(provider)}>
          {formatFetchedAt(checkedAt(provider))}
        </span>
      </div>
    </div>
  );
}

export function ProviderKeysScreen({ data, loading, error, saving, saveError, onSave, onRefresh, onClose }: ProviderKeysScreenProps) {
  const providers = data?.providers ?? [];

  const handleSave = async (key: string, value: string): Promise<boolean> => {
    const ok = await onSave(key, value);
    if (ok) onRefresh();
    return ok;
  };

  return (
    <div className="h-full min-h-0 flex items-start justify-center overflow-hidden">
      <div
        role="dialog"
        aria-label="API keys"
        className="w-full h-full min-h-0 bg-black border-2 border-border/50 relative shadow-lg overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 border-b border-primary/25 px-3 py-2 bg-zinc-950/40 shrink-0">
          <div className="font-mono text-base font-bold tracking-widest text-foreground">API KEYS</div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-3 flex flex-col gap-2">
          <div className="shrink-0 flex justify-end">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="h-8 px-3 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 disabled:hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
              title="Refresh provider status"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              <span className="text-xs font-mono font-bold tracking-[0.18em]">{loading ? 'REFRESHING' : 'REFRESH'}</span>
            </button>
          </div>

          <div className="min-h-0 flex-1 border border-border bg-card/70 rounded overflow-hidden flex flex-col">
            <div className={`grid ${GRID_COLS} gap-3 items-center px-3 py-2 border-b border-border/80 bg-zinc-950/40 shrink-0`}>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Provider</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Environment</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Source</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Key</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Credits</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Tokens</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Last Checked</div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {providers.length > 0 ? providers.map((provider) => (
                <ProviderRow key={provider.envKey} provider={provider} saving={saving} onSave={handleSave} />
              )) : (
                <div className="h-12 flex items-center justify-center gap-2 text-center">
                  <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                  <div className="text-sm font-mono text-muted-foreground">{loading ? 'LOADING...' : 'NO PROVIDERS'}</div>
                </div>
              )}

              {(error ?? saveError) && (
                <div className="m-3 border border-red-400/50 bg-red-500/10 text-red-200 rounded px-3 py-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <div className="text-sm truncate">{error ?? saveError}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

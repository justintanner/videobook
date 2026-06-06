import { RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProviderKeyInfo, ProviderKeyStatusResponse } from '@/hooks/useProviderKeyStatus';

interface ProviderKeysScreenProps {
  data: ProviderKeyStatusResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function label(value: string): string {
  return value.replaceAll('_', ' ').toUpperCase();
}

function formatCredits(provider: ProviderKeyInfo): string {
  if (provider.credits.value === null) return 'N/A';
  return provider.credits.value.toLocaleString(undefined, {
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

function ProviderRow({ provider }: { provider: ProviderKeyInfo }) {
  return (
    <div className="grid grid-cols-[0.75fr_0.95fr_1.35fr_0.55fr_1fr] gap-3 items-center px-3 py-3 border-t border-border/60">
      <div className="min-w-0">
        <div className="font-mono text-sm font-bold text-foreground truncate">{provider.label}</div>
      </div>

      <div className="min-w-0">
        <div className="font-mono text-xs text-zinc-200 truncate">{provider.envKey}</div>
      </div>

      <div className="min-w-0">
        <input
          readOnly
          value={keyDisplay(provider)}
          className="h-8 w-full rounded border border-input bg-black/40 px-2 font-mono text-xs text-zinc-200 shadow-sm truncate focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`${provider.label} API key`}
        />
      </div>

      <div className="min-w-0">
        <div className="font-mono text-base font-bold tabular-nums text-foreground truncate">{formatCredits(provider)}</div>
      </div>

      <div className="min-w-0">
        <span className="font-mono text-xs text-muted-foreground whitespace-nowrap truncate block" title={provider.credits.message ?? undefined}>
          {formatFetchedAt(provider.credits.fetchedAt)}
        </span>
      </div>
    </div>
  );
}

export function ProviderKeysScreen({ data, loading, error, onRefresh }: ProviderKeysScreenProps) {
  const providers = data?.providers ?? [];

  return (
    <div className="h-full min-h-0 flex items-start justify-center overflow-hidden">
      <div
        role="dialog"
        aria-label="API keys"
        className="w-full h-full min-h-0 bg-black border-2 border-border/50 relative shadow-lg overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 border-b border-primary/25 px-3 py-2 bg-zinc-950/40 shrink-0">
          <div className="font-mono text-base font-bold tracking-widest text-foreground">API KEYS</div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="h-8 px-3 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 disabled:cursor-wait transition-colors inline-flex items-center gap-2"
            title="Refresh credits"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
            <span className="text-xs font-mono font-bold tracking-[0.18em]">{loading ? 'REFRESHING' : 'REFRESH'}</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-3">
          <div className="h-full min-h-0 border border-border bg-card/70 rounded overflow-hidden flex flex-col">
            <div className="grid grid-cols-[0.75fr_0.95fr_1.35fr_0.55fr_1fr] gap-3 items-center px-3 py-2 border-b border-border/80 bg-zinc-950/40 shrink-0">
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Provider</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Environment</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Key</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Credits</div>
              <div className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted-foreground uppercase truncate">Last Checked</div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {providers.length > 0 ? providers.map((provider) => (
                <ProviderRow key={provider.provider} provider={provider} />
              )) : (
                <div className="h-12 flex items-center justify-center gap-2 text-center">
                  <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                  <div className="text-sm font-mono text-muted-foreground">{loading ? 'LOADING...' : 'NO PROVIDERS'}</div>
                </div>
              )}

              {error && (
                <div className="m-3 border border-red-400/50 bg-red-500/10 text-red-200 rounded px-3 py-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <div className="text-sm truncate">{error}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

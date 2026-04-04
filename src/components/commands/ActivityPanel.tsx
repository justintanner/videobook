import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ActionLogEntry } from '@/hooks/useProjectActivity';
import type { SyncResult } from '@/hooks/useSync';

type ActionCategory = 'generate' | 'render' | 'upload' | 'transcribe' | 'sync' | 'edit' | 'create' | 'delete' | 'other';

const CATEGORY_STYLES: Record<ActionCategory, { color: string }> = {
  generate:   { color: 'text-fuchsia-400' },
  render:     { color: 'text-amber-400' },
  upload:     { color: 'text-blue-400' },
  transcribe: { color: 'text-sky-400' },
  sync:       { color: 'text-emerald-400' },
  edit:       { color: 'text-zinc-400' },
  create:     { color: 'text-emerald-400' },
  delete:     { color: 'text-red-400' },
  other:      { color: 'text-zinc-500' },
};

function categorize(action: string): ActionCategory {
  if (action.includes('generate') || action.includes('grok') || action.includes('kling') || action.includes('nano-banana') || action.includes('gpt-image')) return 'generate';
  if (action.includes('render')) return 'render';
  if (action.includes('upload')) return 'upload';
  if (action.includes('transcribe') || action.includes('isolate')) return 'transcribe';
  if (action.includes('sync')) return 'sync';
  if (action.includes('trim') || action.includes('edit') || action.includes('assign') || action.includes('clear') || action.includes('whitelist') || action.includes('speed') || action.includes('reverse')) return 'edit';
  if (action.includes('create')) return 'create';
  if (action.includes('delete')) return 'delete';
  return 'other';
}

function shortAction(action: string): string {
  return action.replace(/^tool-/, '').replace(/-/g, ' ');
}

function extractAssetId(payload: string | Record<string, unknown>): string | null {
  if (typeof payload === 'string') return null;
  return (payload.asset_id as string) ?? (payload.vid_asset_id as string) ?? (payload.img_asset_id as string) ?? null;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  if (diffDays === 1) return '1d';
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
}

interface ActivityPanelProps {
  entries: ActionLogEntry[];
  loading: boolean;
  syncResult: SyncResult | undefined;
}

export function ActivityPanel({ entries, loading, syncResult }: ActivityPanelProps) {
  const failures = syncResult?.failed ?? [];

  return (
    <div className="w-80 max-h-96 overflow-y-auto">
      {/* Live failures */}
      {failures.length > 0 && (
        <div className="border-b border-border px-3 py-2">
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-red-400/70">Failures</span>
          {failures.map((f, i) => (
            <div key={`fail-${i}`} className="flex items-center gap-2 py-1.5 text-xs font-mono">
              <span className="text-red-400 font-bold shrink-0">FAIL</span>
              <span className="text-muted-foreground/60 truncate flex-1">{f.assetId}</span>
              <span className="text-red-400/50 truncate max-w-[120px]" title={f.failMsg}>{f.failMsg}</span>
            </div>
          ))}
        </div>
      )}

      {/* Activity entries */}
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <span className="text-xs font-mono text-muted-foreground/30 uppercase tracking-wider">No activity yet</span>
        </div>
      ) : (
        <div className="py-1">
          {entries.map((entry) => {
            const cat = categorize(entry.action);
            const style = CATEGORY_STYLES[cat];
            const assetId = extractAssetId(entry.payload);
            return (
              <div
                key={entry.hash}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-white/5 transition-colors"
              >
                <span className={cn('font-bold shrink-0 w-20 truncate', style.color)}>
                  {shortAction(entry.action)}
                </span>
                <span className="text-muted-foreground/40 truncate flex-1">
                  {assetId ?? ''}
                </span>
                <span className="text-muted-foreground/30 shrink-0">
                  {formatDate(entry.date)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

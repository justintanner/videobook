import { useState, useEffect, useRef, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusHeader } from './StatusHeader';
import { ChatInput } from '@/components/ui/ChatInput';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { CommandDescriptor } from '@/lib/command-registry';
import type { ActionLogEntry } from '@/hooks/useProjectActivity';
import type { SyncResult } from '@/hooks/useSync';
import type { UseMcpResult } from 'use-mcp/react';

type ActionCategory = 'generate' | 'render' | 'upload' | 'transcribe' | 'sync' | 'trim' | 'edit' | 'create' | 'delete' | 'fail' | 'other';

const CATEGORY_STYLES: Record<ActionCategory, { color: string }> = {
  generate:   { color: 'text-fuchsia-400' },
  render:     { color: 'text-amber-400' },
  upload:     { color: 'text-blue-400' },
  transcribe: { color: 'text-sky-400' },
  sync:       { color: 'text-emerald-400' },
  trim:       { color: 'text-teal-400' },
  edit:       { color: 'text-zinc-400' },
  create:     { color: 'text-emerald-400' },
  delete:     { color: 'text-red-400' },
  fail:       { color: 'text-red-400' },
  other:      { color: 'text-zinc-500' },
};

const VISIBLE_CATEGORIES = new Set<ActionCategory>([
  'generate', 'create', 'delete', 'render', 'upload', 'transcribe', 'trim',
]);

function categorize(action: string): ActionCategory {
  if (action.includes('generate') || action.includes('grok') || action.includes('kling') || action.includes('nano-banana') || action.includes('gpt-image')) return 'generate';
  if (action.includes('render')) return 'render';
  if (action.includes('upload') || action.includes('download')) return 'upload';
  if (action.includes('transcribe') || action.includes('isolate')) return 'transcribe';
  if (action.includes('sync')) return 'sync';
  if (action.includes('trim')) return 'trim';
  if (action.includes('edit') || action.includes('assign') || action.includes('clear') || action.includes('whitelist') || action.includes('speed') || action.includes('reverse')) return 'edit';
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

function extractPrompt(payload: string | Record<string, unknown>): string | null {
  if (typeof payload === 'string') return null;
  return (payload.prompt as string) ?? null;
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

const STATUS_COMMANDS: CommandDescriptor[] = [
  {
    command: '/close', description: 'Close status', example: '/close',
    category: 'action', icon: 'X', size: 'sm', variant: 'default', chevron: 'right',
    params: [],
  },
];

interface StatusDrawerProps {
  open: boolean;
  onClose: () => void;
  entries: ActionLogEntry[];
  loading: boolean;
  syncResult: SyncResult | undefined;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

export function StatusDrawer({
  open,
  onClose,
  entries,
  loading,
  syncResult,
  assetSlugs,
  callTool,
  projectSlug,
}: StatusDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const failures = useMemo(() => syncResult?.failed ?? [], [syncResult?.failed]);

  const visibleEntries = useMemo(
    () => entries.filter((entry) => VISIBLE_CATEGORIES.has(categorize(entry.action))),
    [entries],
  );

  // Merge failures into the activity entries as a single chronological list
  type MergedEntry = { kind: 'activity'; entry: ActionLogEntry } | { kind: 'fail'; fail: typeof failures[number] };
  const merged = useMemo(() => {
    const items: MergedEntry[] = [
      ...visibleEntries.map((entry): MergedEntry => ({ kind: 'activity', entry })),
      ...failures.map((fail): MergedEntry => ({ kind: 'fail', fail })),
    ];
    items.sort((a, b) => {
      const dateA = a.kind === 'activity' ? a.entry.date : a.fail.failedAt;
      const dateB = b.kind === 'activity' ? b.entry.date : b.fail.failedAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });
    return items;
  }, [visibleEntries, failures]);

  // Two-phase open: mount then animate in
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => setVisible(false), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Focus lock: prevent clicks on non-interactive elements from stealing focus
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'BUTTON') return;
      if (target.isContentEditable) return;
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      const dialog = dialogRef.current;
      if (!dialog || !dialog.contains(target)) return;
      e.preventDefault();
      const input = dialog.querySelector<HTMLInputElement>('[data-testid="input-chat"]');
      input?.focus();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { dispatch: contextDispatch, commands: contextCommands } = useCommandDispatch();
  const mergedCommands = [...STATUS_COMMANDS, ...contextCommands];

  const handleStatusSend = async (message: string): Promise<boolean> => {
    const trimmed = message.trim();
    if (trimmed === '/close') {
      onClose();
      return true;
    }
    return contextDispatch(message);
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />

      {/* Full-screen container */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Project activity log"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        )}
      >
        <StatusHeader
          entryCount={visibleEntries.length}
          failureCount={failures.length}
          onClose={onClose}
        />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && merged.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : merged.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <span className="text-sm font-mono text-muted-foreground/30 uppercase tracking-wider">No activity yet</span>
            </div>
          ) : (
            <div>
              {merged.map((item, i) => {
                if (item.kind === 'fail') {
                  const style = CATEGORY_STYLES.fail;
                  return (
                    <div
                      key={`fail-${item.fail.assetId}-${i}`}
                      className="flex items-start gap-4 px-4 py-3 text-sm font-mono hover:bg-white/5 transition-colors border-b border-red-500/10"
                    >
                      <span className={cn('font-bold shrink-0 w-28 uppercase text-xs tracking-wider pt-0.5', style.color)}>
                        fail
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-red-400/70">{item.fail.failMsg}</div>
                        <div className="text-muted-foreground/50 text-xs mt-0.5">{item.fail.assetId}</div>
                      </div>
                      <span className="text-muted-foreground/30 shrink-0 text-xs pt-0.5">
                        {formatDate(item.fail.failedAt)}
                      </span>
                    </div>
                  );
                }
                const entry = item.entry;
                const cat = categorize(entry.action);
                const style = CATEGORY_STYLES[cat];
                const assetId = extractAssetId(entry.payload);
                const prompt = extractPrompt(entry.payload);
                return (
                  <div
                    key={entry.hash}
                    className="flex items-start gap-4 px-4 py-3 text-sm font-mono hover:bg-white/5 transition-colors border-b border-border/10"
                  >
                    <span className={cn('font-bold shrink-0 w-28 uppercase text-xs tracking-wider pt-0.5', style.color)}>
                      {cat}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground/80">{shortAction(entry.action)}</div>
                      {assetId && (
                        <div className="text-muted-foreground/50 text-xs mt-0.5">{assetId}</div>
                      )}
                      {prompt && (
                        <div className="text-muted-foreground/40 text-xs mt-0.5 italic truncate">{prompt}</div>
                      )}
                    </div>
                    <span className="text-muted-foreground/30 shrink-0 text-xs pt-0.5">
                      {formatDate(entry.date)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ChatInput bar */}
        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={mergedCommands}
            onSend={handleStatusSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder="type /close to exit..."
          />
        </div>
      </div>
    </>
  );
}

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { CommandDescriptor } from '@/lib/command-registry';
import type { ActionLogEntry } from '@/hooks/useProjectActivity';
import type { UseMcpResult } from 'use-mcp/react';

type ActionCategory =
  | 'generate'
  | 'render'
  | 'upload'
  | 'transcribe'
  | 'trim'
  | 'edit'
  | 'create'
  | 'delete'
  | 'fail'
  | 'rewind'
  | 'other';

interface CategoryStyle {
  label: string;
  accent: string;
  glow: string;
}

const CATEGORY_STYLES: Record<ActionCategory, CategoryStyle> = {
  generate:   { label: 'text-fuchsia-300 drop-shadow-[0_0_6px_rgba(217,70,239,0.55)]', accent: 'border-l-fuchsia-500/70', glow: 'shadow-[inset_3px_0_10px_-2px_rgba(217,70,239,0.35)]' },
  render:     { label: 'text-amber-300 drop-shadow-[0_0_6px_rgba(251,191,36,0.55)]',    accent: 'border-l-amber-500/70',   glow: 'shadow-[inset_3px_0_10px_-2px_rgba(251,191,36,0.35)]' },
  upload:     { label: 'text-blue-300 drop-shadow-[0_0_6px_rgba(96,165,250,0.55)]',     accent: 'border-l-blue-500/70',    glow: 'shadow-[inset_3px_0_10px_-2px_rgba(96,165,250,0.35)]' },
  transcribe: { label: 'text-sky-300 drop-shadow-[0_0_6px_rgba(56,189,248,0.55)]',      accent: 'border-l-sky-500/70',     glow: 'shadow-[inset_3px_0_10px_-2px_rgba(56,189,248,0.35)]' },
  trim:       { label: 'text-teal-300 drop-shadow-[0_0_6px_rgba(45,212,191,0.55)]',     accent: 'border-l-teal-500/70',    glow: 'shadow-[inset_3px_0_10px_-2px_rgba(45,212,191,0.35)]' },
  edit:       { label: 'text-zinc-300 drop-shadow-[0_0_4px_rgba(161,161,170,0.4)]',     accent: 'border-l-zinc-500/60',    glow: 'shadow-[inset_3px_0_8px_-2px_rgba(161,161,170,0.25)]' },
  create:     { label: 'text-emerald-300 drop-shadow-[0_0_6px_rgba(16,185,129,0.55)]',  accent: 'border-l-emerald-500/70', glow: 'shadow-[inset_3px_0_10px_-2px_rgba(16,185,129,0.35)]' },
  delete:     { label: 'text-red-300 drop-shadow-[0_0_6px_rgba(239,68,68,0.55)]',       accent: 'border-l-red-500/70',     glow: 'shadow-[inset_3px_0_10px_-2px_rgba(239,68,68,0.35)]' },
  fail:       { label: 'text-red-300 drop-shadow-[0_0_8px_rgba(239,68,68,0.75)]',       accent: 'border-l-red-500/80',     glow: 'activity-fail-pulse' },
  rewind:     { label: 'text-violet-300 drop-shadow-[0_0_6px_rgba(167,139,250,0.55)]',  accent: 'border-l-violet-500/70',  glow: 'shadow-[inset_3px_0_10px_-2px_rgba(167,139,250,0.35)]' },
  other:      { label: 'text-zinc-400/70',                                               accent: 'border-l-zinc-600/40',    glow: '' },
};

function hasError(payload: string | Record<string, unknown> | undefined): boolean {
  return typeof payload === 'object' && payload !== null && '_error' in payload;
}

function categorize(action: string, payload: string | Record<string, unknown> | undefined): ActionCategory {
  if (action === 'job-error' || hasError(payload)) return 'fail';
  if (action.includes('rewind') || action.includes('restore')) return 'rewind';
  if (action.includes('generate') || action.includes('grok') || action.includes('kling') || action.includes('nano-banana') || action.includes('gpt-image')) return 'generate';
  if (action.includes('render')) return 'render';
  if (action.includes('upload') || action.includes('download')) return 'upload';
  if (action.includes('transcribe') || action.includes('isolate')) return 'transcribe';
  if (action.includes('trim')) return 'trim';
  if (action.includes('edit') || action.includes('assign') || action.includes('clear') || action.includes('speed') || action.includes('reverse')) return 'edit';
  if (action.includes('create')) return 'create';
  if (action.includes('delete')) return 'delete';
  return 'other';
}

function shortAction(action: string): string {
  return action.replace(/^tool-/, '').replace(/-/g, ' ');
}

function extractAssetId(payload: string | Record<string, unknown> | undefined): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return (payload.assetId as string) ?? (payload.asset_id as string) ?? (payload.vid_asset_id as string) ?? (payload.img_asset_id as string) ?? null;
}

function extractPrompt(payload: string | Record<string, unknown> | undefined): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return (payload.prompt as string) ?? null;
}

function extractError(payload: string | Record<string, unknown> | undefined): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return (payload._error as string) ?? (payload.error as string) ?? null;
}

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return 'T-00:00';
  if (diffMin < 60) return `T-${String(diffMin).padStart(2, '0')}m`;
  if (diffHr < 24) return `T-${String(diffHr).padStart(2, '0')}h`;
  if (diffDays === 1) return 'T-01d';
  if (diffDays < 7) return `T-${String(diffDays).padStart(2, '0')}d`;
  return date.toLocaleDateString();
}

function formatAbsolute(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatPayload(payload: string | Record<string, unknown> | undefined): string {
  if (payload === undefined) return 'snapshot';
  if (typeof payload === 'string') return payload;
  if (payload === null || payload === undefined) return String(payload);
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

const STATUS_COMMANDS: CommandDescriptor[] = [
  {
    command: '/close', description: 'Close activity log', example: '/close',
    category: 'action', icon: 'X', size: 'sm', variant: 'default', chevron: 'right',
    params: [],
  },
];

interface ActivityLogDrawerProps {
  open: boolean;
  onClose: () => void;
  entries: ActionLogEntry[];
  loading: boolean;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
  onRewound?: () => void | Promise<void>;
}

export function ActivityLogDrawer({
  open,
  onClose,
  entries,
  loading,
  assetSlugs,
  callTool,
  projectSlug,
  onRewound,
}: ActivityLogDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rewindingHash, setRewindingHash] = useState<string | null>(null);
  const [rewindError, setRewindError] = useState<string | null>(null);

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [entries],
  );

  const toggleExpanded = useCallback((hash: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setVisible(open), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

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

  const handleRewind = useCallback(async (entry: ActionLogEntry) => {
    if (!projectSlug || rewindingHash) return;
    const ok = window.confirm(`Rewind project to #${shortHash(entry.hash)}? Active jobs for this project will be stopped.`);
    if (!ok) return;
    setRewindingHash(entry.hash);
    setRewindError(null);
    try {
      const result = await callTool('rewind_project', {
        project_slug: projectSlug,
        commit_hash: entry.hash,
      });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }>;
        setRewindError(content[0]?.text ?? 'Rewind failed');
        return;
      }
      await onRewound?.();
    } catch (error) {
      setRewindError(error instanceof Error ? error.message : String(error));
    } finally {
      setRewindingHash(null);
    }
  }, [callTool, onRewound, projectSlug, rewindingHash]);

  if (!open) return null;

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 bg-black/85 backdrop-blur-sm z-[100] transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Project activity log"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          'activity-scanlines',
          'border border-emerald-500/20',
          'shadow-[0_0_120px_rgba(16,185,129,0.08)_inset]',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-emerald-500/30 shrink-0 shadow-[0_1px_0_rgba(16,185,129,0.25),0_8px_24px_-20px_rgba(16,185,129,0.6)]">
          <div className="flex items-center gap-3">
            <span className="text-emerald-400 activity-cursor-blink text-lg leading-none font-mono">▮</span>
            <span className="activity-title-in text-xs font-mono font-bold tracking-[0.35em] text-emerald-300 drop-shadow-[0_0_6px_rgba(16,185,129,0.55)] uppercase">
              ACTIVITY_LOG
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close activity log"
            className="text-emerald-400/70 hover:text-red-400 hover:drop-shadow-[0_0_6px_rgba(248,113,113,0.8)] transition-all font-mono text-xs tracking-widest"
          >
            [ X ]
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {rewindError && (
            <div className="mb-3 border border-red-500/40 bg-red-500/[0.08] px-3 py-2 text-[11px] font-mono text-red-200">
              {rewindError}
            </div>
          )}
          {loading && sortedEntries.length === 0 ? (
            <div className="flex items-center justify-center py-24">
              <span className="text-xs font-mono tracking-widest text-emerald-400/80 uppercase activity-loading-blocks">
                loading
              </span>
            </div>
          ) : sortedEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-2 text-emerald-400/50 font-mono text-xs tracking-widest">
              <div>[ NO SIGNAL ]</div>
              <div className="text-emerald-500/30">░░░░░░░░░░░░</div>
              <div className="text-emerald-400/30 uppercase">awaiting input…</div>
            </div>
          ) : (
            <div className="flex flex-col">
              {sortedEntries.map((entry, i) => {
                const cat = entry.category ?? categorize(entry.action, entry.payload);
                const style = CATEGORY_STYLES[cat];
                const assetId = entry.assetId ?? extractAssetId(entry.payload);
                const prompt = extractPrompt(entry.payload);
                const errorMsg = cat === 'fail' ? extractError(entry.payload) : null;
                const isFail = cat === 'fail';
                const isExpanded = expanded.has(entry.hash);
                const isRewinding = rewindingHash === entry.hash;
                const canRewind = entry.rewindable !== false && projectSlug !== undefined;
                const title = entry.title ?? shortAction(entry.action);
                const delay = Math.min(i, 20) * 20;
                return (
                  <div
                    key={entry.hash}
                    className="activity-row-boot"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    <div
                      className={cn(
                        'group w-full flex items-stretch gap-0 text-sm font-mono',
                        'border-b border-l-2 border-emerald-500/5',
                        'hover:bg-emerald-500/[0.04] transition-colors',
                        style.accent,
                        style.glow,
                        isFail && 'bg-red-500/[0.03]',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleExpanded(entry.hash)}
                        className="flex-1 min-w-0 text-left flex items-start gap-4 px-4 py-3"
                        aria-expanded={isExpanded}
                      >
                        <span className={cn('shrink-0 w-32 uppercase text-[10px] tracking-[0.15em] pt-0.5 font-bold', style.label)}>
                          [{cat}]
                        </span>
                        <div className="flex-1 min-w-0">
                          {isFail && errorMsg ? (
                            <div className="text-red-300/90 truncate">{errorMsg}</div>
                          ) : (
                            <div className="text-emerald-100/80 uppercase tracking-wider text-xs">{title}</div>
                          )}
                          {assetId && (
                            <div className="text-emerald-400/50 text-[10px] mt-0.5 tracking-wider">› {assetId}</div>
                          )}
                          {!isFail && prompt && (
                            <div className="text-emerald-400/40 text-[10px] mt-0.5 italic truncate">"{prompt}"</div>
                          )}
                        </div>
                        <span className="shrink-0 text-[10px] pt-0.5 text-emerald-400/50 tracking-wider tabular-nums">
                          {formatRelative(entry.date)}
                        </span>
                        <span className={cn(
                          'shrink-0 pt-0.5 text-emerald-400/60 font-mono text-xs transition-transform',
                          isExpanded ? 'rotate-90' : 'group-hover:translate-x-0.5',
                        )}>
                          ▸
                        </span>
                      </button>
                      {canRewind && (
                        <button
                          type="button"
                          onClick={() => handleRewind(entry)}
                          disabled={rewindingHash !== null}
                          className={cn(
                            'shrink-0 px-3 border-l border-emerald-500/10 text-[10px] tracking-[0.16em] uppercase',
                            'text-violet-300/75 hover:text-violet-200 hover:bg-violet-500/[0.08] transition-colors',
                            'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-violet-300/75',
                          )}
                        >
                          {isRewinding ? 'rewinding' : 'rewind'}
                        </button>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-1 bg-black/40">
                        <div className="text-[10px] font-mono text-emerald-400/70 tracking-wider mb-1">
                          ┌─ {formatAbsolute(entry.date)} · #{shortHash(entry.hash)} ─ {entry.source ?? 'action'}:{entry.action} ─┐
                        </div>
                        <pre className="font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-emerald-200/80 bg-black/70 border border-emerald-500/25 px-3 py-2 shadow-[inset_0_0_32px_rgba(16,185,129,0.06)] max-h-[480px] overflow-y-auto">
{formatPayload(entry.payload)}
                        </pre>
                        <div className="text-[10px] font-mono text-emerald-400/70 tracking-wider mt-1">
                          └────────────────────────────────────────┘
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-emerald-500/30 px-6 py-3 shadow-[0_-8px_24px_-20px_rgba(16,185,129,0.6)]">
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

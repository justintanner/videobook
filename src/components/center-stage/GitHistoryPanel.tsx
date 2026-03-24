import { RefreshCw, RotateCcw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import { CommandButton } from '@/components/commands';
import type { GitCommit } from '@/hooks/useAssetHistory';

type CommitOperation =
  | 'create' | 'generate' | 'upload' | 'render' | 'restore' | 'delete' | 'rename'
  | 'write' | 'process_video' | 'transcribe' | 'render-timeline' | 'delete-file' | 'rename-file' | 'copy-file';

const OPERATION_STYLES: Record<CommitOperation, { dot: string; label: string }> = {
  create:            { dot: 'bg-emerald-500', label: 'text-emerald-400' },
  generate:          { dot: 'bg-primary',     label: 'text-primary' },
  upload:            { dot: 'bg-blue-500',    label: 'text-blue-400' },
  render:            { dot: 'bg-amber-500',   label: 'text-amber-400' },
  restore:           { dot: 'bg-violet-500',  label: 'text-violet-400' },
  delete:            { dot: 'bg-red-500',     label: 'text-red-400' },
  rename:            { dot: 'bg-zinc-500',    label: 'text-zinc-400' },
  write:             { dot: 'bg-emerald-500', label: 'text-emerald-400' },
  'process_video':   { dot: 'bg-amber-500',   label: 'text-amber-400' },
  transcribe:        { dot: 'bg-sky-500',     label: 'text-sky-400' },
  'render-timeline': { dot: 'bg-amber-500',   label: 'text-amber-400' },
  'delete-file':     { dot: 'bg-red-500',     label: 'text-red-400' },
  'rename-file':     { dot: 'bg-zinc-500',    label: 'text-zinc-400' },
  'copy-file':       { dot: 'bg-blue-500',    label: 'text-blue-400' },
};

function extractOperation(message: string): CommitOperation {
  const afterBracket = message.replace(/^\[[^\]]*\]\s*/, '');
  const token = afterBracket.split(/[\s:(]/)[0].toLowerCase();
  if (token in OPERATION_STYLES) return token as CommitOperation;
  return 'create';
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function HistoryListPane({ commits, selectedHash, onSelectCommit, onRefresh, loading }: {
  commits: GitCommit[];
  selectedHash: string | null;
  onSelectCommit: (hash: string) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-[10px] font-mono text-muted-foreground/30 uppercase tracking-wider">
          {loading ? '...' : `${commits.length} commits`}
        </span>
        <button
          tabIndex={-1}
          onClick={onRefresh}
          className="w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors"
        >
          <RefreshCw className={cn('w-3 h-3 stroke-[2.5]', loading && 'animate-spin')} />
        </button>
      </div>
      {commits.map((commit, i) => {
        const op = extractOperation(commit.message);
        const style = OPERATION_STYLES[op];
        const isHead = i === 0;
        const isSelected = commit.hash === selectedHash;
        return (
          <button
            key={commit.hash}
            tabIndex={-1}
            onClick={() => onSelectCommit(commit.hash)}
            className={cn(
              'w-full text-left px-3 py-2 text-xs font-mono flex items-center gap-2 transition-colors',
              isSelected
                ? 'bg-primary/10 border-l-2 border-primary text-primary'
                : 'border-l-2 border-transparent hover:bg-white/5',
            )}
          >
            <div className="relative shrink-0 flex items-center justify-center w-3">
              {isHead ? (
                <>
                  <div className={cn('w-2.5 h-2.5 rounded-full', style.dot)} />
                  <div className={cn('absolute w-2.5 h-2.5 rounded-full animate-ping opacity-40', style.dot)} />
                </>
              ) : (
                <div className={cn('w-2 h-2 rounded-full', style.dot)} />
              )}
            </div>
            <span className={cn('font-bold shrink-0', style.label)}>{op}</span>
            <span className="text-muted-foreground/30 shrink-0">{commit.hash.slice(0, 7)}</span>
            <span className="flex-1" />
            <span className="text-[10px] text-muted-foreground/30 shrink-0">{formatDate(commit.date)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function HistoryDetailPane({ commit, isHead, onRestore }: {
  commit: GitCommit | null;
  isHead: boolean;
  onRestore: (hash: string) => void;
}) {
  if (!commit) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="text-sm font-mono text-muted-foreground/30 tracking-wider uppercase">Select a commit</span>
      </div>
    );
  }

  const op = extractOperation(commit.message);
  const style = OPERATION_STYLES[op];

  return (
    <div className="h-full flex flex-col p-5 gap-5">
      {/* Operation label + HEAD indicator */}
      <div className="flex items-center gap-3">
        <span className={cn('font-mono text-base font-bold uppercase tracking-widest', style.label)}>
          {op}
        </span>
        {isHead && (
          <span className="text-xs font-mono font-bold uppercase tracking-widest text-zinc-500">
            HEAD
          </span>
        )}
      </div>

      {/* Commit info */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono uppercase w-16 tracking-wider text-zinc-600">Hash</span>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(commit.hash);
              toast({ title: 'Copied', description: commit.hash, duration: 2000 });
            }}
            className="text-sm font-mono text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            {commit.hash}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono uppercase w-16 tracking-wider text-zinc-600">Date</span>
          <span className="text-sm font-mono text-zinc-400">{formatDate(commit.date)}</span>
        </div>
      </div>

      {/* Files changed */}
      {commit.files && commit.files.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-mono uppercase tracking-wider text-zinc-600">Files changed</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {commit.files.map((file) => (
              <span key={file} className="text-sm font-mono text-zinc-500">{file}</span>
            ))}
          </div>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Action: /restore or current version label */}
      {isHead ? (
        <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-zinc-600 text-center">
          Current Version
        </span>
      ) : (
        <CommandButton
          command={`/restore ${commit.hash.slice(0, 7)}`}
          icon={<RotateCcw className="w-4 h-4" />}
          onClick={() => {
            if (window.confirm(`Restore to ${commit.hash.slice(0, 7)}? This will revert to this version.`)) {
              onRestore(commit.hash);
            }
          }}
        />
      )}
    </div>
  );
}

export function HistoryEmptyState({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-cyan-400/50" />
          <span className="text-sm font-mono text-muted-foreground/50">Loading history...</span>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center">
      <span className="text-sm font-mono text-muted-foreground/30 tracking-wider uppercase">No history found</span>
    </div>
  );
}

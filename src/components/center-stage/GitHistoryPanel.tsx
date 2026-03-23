import { RefreshCw, RotateCcw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import type { GitCommit } from '@/hooks/useAssetHistory';

type CommitOperation =
  | 'create' | 'generate' | 'upload' | 'render' | 'restore' | 'delete' | 'rename'
  | 'write' | 'process_video' | 'transcribe' | 'render-timeline' | 'delete-file' | 'rename-file' | 'copy-file';

const OPERATION_STYLES: Record<CommitOperation, { dot: string; label: string; glow: string }> = {
  create:            { dot: 'bg-emerald-500', label: 'text-emerald-400', glow: 'shadow-[0_0_8px_rgba(16,185,129,0.4)]' },
  generate:          { dot: 'bg-primary',     label: 'text-primary',     glow: 'shadow-[0_0_8px_rgba(0,217,255,0.4)]' },
  upload:            { dot: 'bg-blue-500',    label: 'text-blue-400',    glow: 'shadow-[0_0_8px_rgba(59,130,246,0.4)]' },
  render:            { dot: 'bg-amber-500',   label: 'text-amber-400',   glow: 'shadow-[0_0_8px_rgba(245,158,11,0.4)]' },
  restore:           { dot: 'bg-violet-500',  label: 'text-violet-400',  glow: 'shadow-[0_0_8px_rgba(139,92,246,0.4)]' },
  delete:            { dot: 'bg-red-500',     label: 'text-red-400',     glow: 'shadow-[0_0_8px_rgba(239,68,68,0.4)]' },
  rename:            { dot: 'bg-zinc-500',    label: 'text-zinc-400',    glow: 'shadow-[0_0_8px_rgba(161,161,170,0.4)]' },
  write:             { dot: 'bg-emerald-500', label: 'text-emerald-400', glow: 'shadow-[0_0_8px_rgba(16,185,129,0.4)]' },
  'process_video':   { dot: 'bg-amber-500',   label: 'text-amber-400',   glow: 'shadow-[0_0_8px_rgba(245,158,11,0.4)]' },
  transcribe:        { dot: 'bg-sky-500',     label: 'text-sky-400',     glow: 'shadow-[0_0_8px_rgba(14,165,233,0.4)]' },
  'render-timeline': { dot: 'bg-amber-500',   label: 'text-amber-400',   glow: 'shadow-[0_0_8px_rgba(245,158,11,0.4)]' },
  'delete-file':     { dot: 'bg-red-500',     label: 'text-red-400',     glow: 'shadow-[0_0_8px_rgba(239,68,68,0.4)]' },
  'rename-file':     { dot: 'bg-zinc-500',    label: 'text-zinc-400',    glow: 'shadow-[0_0_8px_rgba(161,161,170,0.4)]' },
  'copy-file':       { dot: 'bg-blue-500',    label: 'text-blue-400',    glow: 'shadow-[0_0_8px_rgba(59,130,246,0.4)]' },
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

const pixelGridStyle = {
  backgroundImage:
    'linear-gradient(rgba(0, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.1) 1px, transparent 1px)',
  backgroundSize: '4px 4px',
};

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
    <div className="relative h-full flex flex-col">
      {/* Scanlines overlay */}
      <div className="absolute inset-0 pointer-events-none scanlines opacity-10 z-10" />
      {/* Pixel grid */}
      <div className="absolute inset-0 pointer-events-none opacity-5" style={pixelGridStyle} />

      {/* Corner accents */}
      <svg className="absolute top-0 left-0 w-5 h-5 text-cyan-400/20 z-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M0 12 L12 0" /><path d="M0 6 L6 0" />
      </svg>
      <svg className="absolute bottom-0 right-0 w-5 h-5 text-cyan-400/20 z-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M24 12 L12 24" /><path d="M24 18 L18 24" />
      </svg>

      {/* Content */}
      <div className="relative z-10 flex-1 flex flex-col p-5 gap-5">
        {/* Operation badge */}
        <div className="flex items-center gap-3">
          <div className={cn('px-3 py-1.5 rounded font-mono text-sm font-bold uppercase tracking-[0.15em]', style.label, style.glow)} style={{ background: 'rgba(0,0,0,0.5)' }}>
            {op}
          </div>
          {isHead && (
            <span className="px-2 py-1 rounded text-[10px] font-mono font-bold uppercase tracking-[0.15em] text-cyan-400 border border-cyan-400/30 bg-cyan-400/5">
              HEAD
            </span>
          )}
        </div>

        {/* Commit info */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground/40 uppercase w-12">Hash</span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(commit.hash);
                toast({ title: 'Copied', description: commit.hash, duration: 2000 });
              }}
              className="text-xs font-mono text-muted-foreground hover:text-cyan-400 transition-colors cursor-pointer"
            >
              {commit.hash}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground/40 uppercase w-12">Date</span>
            <span className="text-xs font-mono text-muted-foreground">{formatDate(commit.date)}</span>
          </div>
        </div>

        {/* Files changed */}
        {commit.files && commit.files.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wider">Files changed</span>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {commit.files.map((file) => (
                <span key={file} className="text-[11px] font-mono text-muted-foreground/60">{file}</span>
              ))}
            </div>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Restore button */}
        {isHead ? (
          <div className="flex items-center justify-center py-3 border border-cyan-400/20 rounded bg-cyan-400/5">
            <span className="text-xs font-mono font-bold tracking-[0.15em] uppercase text-cyan-400/50">Current Version</span>
          </div>
        ) : (
          <button
            onClick={() => {
              if (window.confirm(`Rewind to ${commit.hash.slice(0, 7)}? This will restore this version.`)) {
                onRestore(commit.hash);
              }
            }}
            className={cn(
              'group/btn flex items-center justify-center gap-2 py-2 px-4 rounded cursor-pointer w-fit',
              'border border-cyan-400/50 bg-cyan-950/30',
              'shadow-[0_0_10px_-5px_rgba(0,255,255,0.3)]',
              'hover:border-cyan-400 hover:bg-cyan-950/50 hover:shadow-[0_0_15px_-5px_rgba(0,255,255,0.5)]',
              'active:scale-[0.98]',
              'transition-all duration-150',
            )}
          >
            <RotateCcw className="w-3.5 h-3.5 text-cyan-400/70 group-hover/btn:text-cyan-400 transition-colors" />
            <span className="font-mono text-xs font-bold tracking-[0.15em] uppercase text-cyan-400/70 group-hover/btn:text-cyan-400 transition-colors">
              Rewind
            </span>
          </button>
        )}
      </div>
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

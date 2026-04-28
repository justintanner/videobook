import { RefreshCw, History, Copy, Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import { CommandButton } from '@/components/commands';
import type { GitCommit, RewriteMeta } from '@/hooks/useAssetHistory';

type CommitOperation =
  | 'create' | 'generate' | 'upload' | 'render' | 'restore' | 'delete' | 'rename'
  | 'write' | 'process_video' | 'transcribe' | 'render-timeline' | 'delete-file' | 'rename-file' | 'copy-file';

const OPERATION_STYLES: Record<CommitOperation, { label: string }> = {
  create:            { label: 'text-emerald-400' },
  generate:          { label: 'text-primary' },
  upload:            { label: 'text-blue-400' },
  render:            { label: 'text-amber-400' },
  restore:           { label: 'text-violet-400' },
  delete:            { label: 'text-red-400' },
  rename:            { label: 'text-zinc-400' },
  write:             { label: 'text-emerald-400' },
  'process_video':   { label: 'text-amber-400' },
  transcribe:        { label: 'text-sky-400' },
  'render-timeline': { label: 'text-amber-400' },
  'delete-file':     { label: 'text-red-400' },
  'rename-file':     { label: 'text-zinc-400' },
  'copy-file':       { label: 'text-blue-400' },
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
        <span className="text-xs font-mono text-muted-foreground/50 uppercase tracking-wider">
          {loading ? '...' : `${commits.length} commits`}
        </span>
        <button
          tabIndex={-1}
          onClick={onRefresh}
          className="w-6 h-6 flex items-center justify-center text-muted-foreground/60 hover:text-primary transition-colors"
        >
          <RefreshCw className={cn('w-4 h-4 stroke-[2.5]', loading && 'animate-spin')} />
        </button>
      </div>
      {commits.map((commit) => {
        const op = extractOperation(commit.message);
        const style = OPERATION_STYLES[op];
        const isSelected = commit.hash === selectedHash;
        return (
          <button
            key={commit.hash}
            tabIndex={-1}
            onClick={() => onSelectCommit(commit.hash)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm font-mono flex items-center gap-2 transition-colors',
              isSelected
                ? 'bg-primary/10 border-l-2 border-primary text-primary'
                : 'border-l-2 border-transparent hover:bg-white/5',
            )}
          >
            <span className={cn('font-bold shrink-0', style.label)}>{op}</span>
            <span className="text-muted-foreground/30 shrink-0">{commit.hash.slice(0, 7)}</span>
            <span className="flex-1" />
            <span className="text-muted-foreground/30 shrink-0">{formatDate(commit.date)}</span>
          </button>
        );
      })}
    </div>
  );
}

function RewriteMetadataBlock({ rewrite, onReuse }: {
  rewrite: RewriteMeta;
  onReuse?: (meta: RewriteMeta) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-amber-300/90">
        <Zap className="w-3 h-3" />
        Rewrite
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono uppercase w-16 tracking-wider text-amber-500/50">Model</span>
          <span className="text-sm font-mono text-amber-100">{rewrite.model}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono uppercase w-16 tracking-wider text-amber-500/50">Variant</span>
          <span className="text-sm font-mono text-amber-100">{rewrite.variant}</span>
        </div>
        {rewrite.platform && (
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono uppercase w-16 tracking-wider text-amber-500/50">Platform</span>
            <span className="text-sm font-mono text-amber-100">{rewrite.platform}</span>
          </div>
        )}
        {rewrite.customPrompt && (
          <div className="flex items-start gap-3">
            <span className="shrink-0 text-xs font-mono uppercase w-16 tracking-wider text-amber-500/50 pt-0.5">Prompt</span>
            <span className="text-sm font-mono text-amber-100 whitespace-pre-wrap break-words">
              {rewrite.customPrompt}
            </span>
          </div>
        )}
      </div>
      {onReuse && (
        <button
          type="button"
          onClick={() => onReuse(rewrite)}
          className={cn(
            'mt-1 h-7 px-2.5 flex items-center justify-center gap-1.5 rounded',
            'text-[11px] font-mono font-bold uppercase tracking-wider',
            'text-amber-200 hover:text-amber-100',
            'bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/50 hover:border-amber-300/80',
            'transition-colors duration-150',
          )}
        >
          <Zap className="w-3.5 h-3.5" />
          Use this prompt
        </button>
      )}
    </div>
  );
}

export function HistoryDetailPane({ commit, isHead, onRestore, onReusePrompt }: {
  commit: GitCommit | null;
  isHead: boolean;
  onRestore: (hash: string) => void;
  onReusePrompt?: (meta: RewriteMeta) => void;
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
      {/* Top row: operation label + copy icon */}
      <div className="flex items-center gap-3">
        <span className={cn('font-mono text-base font-bold uppercase tracking-widest', style.label)}>
          {op}
        </span>
        {isHead && (
          <span className="text-xs font-mono font-bold uppercase tracking-widest text-zinc-500">
            HEAD
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(commit.hash);
            toast({ title: 'Copied', description: commit.hash, duration: 2000 });
          }}
          className="w-7 h-7 flex items-center justify-center text-muted-foreground/60 hover:text-white transition-colors"
        >
          <Copy className="w-5 h-5 stroke-[2]" />
        </button>
      </div>

      {/* Commit info */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono uppercase w-16 tracking-wider text-zinc-600">Hash</span>
          <span className="text-sm font-mono text-zinc-400">{commit.hash}</span>
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

      {/* Rewrite metadata (scripts only) */}
      {commit.rewrite && (
        <RewriteMetadataBlock rewrite={commit.rewrite} onReuse={onReusePrompt} />
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
          icon={<History className="w-4 h-4" />}
          onClick={() => onRestore(commit.hash)}
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

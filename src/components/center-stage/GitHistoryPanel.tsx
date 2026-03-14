import { useEffect } from 'react';
import { History, RotateCcw, X, Film, ImageIcon, Music, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UseMcpResult } from 'use-mcp/react';
import { useAssetHistory, type GitCommit } from '@/hooks/useAssetHistory';
import type { MediaItem } from '@/components/sidebar/types';

type CommitOperation = 'create' | 'generate' | 'upload' | 'render' | 'restore' | 'delete' | 'rename';

const OPERATION_STYLES: Record<CommitOperation, { dot: string; label: string }> = {
  create:   { dot: 'bg-emerald-500', label: 'text-emerald-400' },
  generate: { dot: 'bg-primary',     label: 'text-primary' },
  upload:   { dot: 'bg-blue-500',    label: 'text-blue-400' },
  render:   { dot: 'bg-amber-500',   label: 'text-amber-400' },
  restore:  { dot: 'bg-violet-500',  label: 'text-violet-400' },
  delete:   { dot: 'bg-red-500',     label: 'text-red-400' },
  rename:   { dot: 'bg-zinc-500',    label: 'text-zinc-400' },
};

function extractOperation(message: string): CommitOperation {
  const first = message.split(/[\s:(]/)[0].toLowerCase();
  if (first in OPERATION_STYLES) return first as CommitOperation;
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

const TYPE_ICONS: Record<string, typeof Film> = {
  video: Film,
  final: Film,
  image: ImageIcon,
  audio: Music,
  script: FileText,
  plan: FileText,
};

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground/50 uppercase">{label}</span>
      <span className="text-sm font-mono text-foreground/80">{children}</span>
    </div>
  );
}

function TimelineNode({ commit, isHead, onRestore }: {
  commit: GitCommit;
  isHead: boolean;
  onRestore: (hash: string) => void;
}) {
  const op = extractOperation(commit.message);
  const style = OPERATION_STYLES[op];
  return (
    <div className="relative flex items-start gap-4 pl-[15px] py-2 group">
      {/* Vertical line */}
      <div className="absolute left-[15px] top-0 bottom-0 w-px bg-border/40" />
      {/* Dot */}
      <div className="relative z-10 shrink-0 flex items-center justify-center" style={{ width: 12, height: 24 }}>
        {isHead ? (
          <div className="relative">
            <div className={cn('w-3 h-3 rounded-full', style.dot)} />
            <div className={cn('absolute inset-0 w-3 h-3 rounded-full animate-ping opacity-40', style.dot)} />
          </div>
        ) : (
          <div className={cn('w-2 h-2 rounded-full', style.dot)} />
        )}
      </div>
      {/* Content */}
      <div className="flex-1 flex items-baseline justify-between gap-3 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={cn('text-xs font-mono font-bold', style.label)}>{op}</span>
          <span className="text-[11px] font-mono text-muted-foreground/60">{commit.hash.slice(0, 7)}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[11px] font-mono text-muted-foreground/50">{formatDate(commit.date)}</span>
          {!isHead && (
            <button
              onClick={() => onRestore(commit.hash)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider text-violet-400 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-colors uppercase"
            >
              <RotateCcw className="w-3 h-3" />
              Restore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface GitHistoryPanelProps {
  item: MediaItem;
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}

export function GitHistoryPanel({ item, projectSlug, callTool, onClose }: GitHistoryPanelProps) {
  const { commits, loading, fetchHistory, restoreVersion } = useAssetHistory(callTool);

  useEffect(() => {
    fetchHistory(item.id, projectSlug);
  }, [item.id, projectSlug, fetchHistory]);

  const handleRestore = async (hash: string) => {
    const ok = await restoreVersion(item.id, hash, projectSlug);
    if (ok) fetchHistory(item.id, projectSlug);
  };

  const headCommit = commits[0];
  const headOp = headCommit ? extractOperation(headCommit.message) : null;
  const TypeIcon = TYPE_ICONS[item.type] ?? FileText;

  return (
    <div className="w-full h-full flex flex-col bg-background border border-border/50 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-3">
          <History className="w-4 h-4 text-primary/70" />
          <span className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">ASSET_HISTORY</span>
          <span className="text-xs font-mono text-muted-foreground/60">{item.id}</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 flex min-h-0">
        {/* Left panel — asset info */}
        <div className="w-[240px] shrink-0 border-r border-border/50 flex flex-col gap-5 px-5 py-5">
          {/* Thumbnail */}
          {(item.thumbnailSrc ?? item.filePath) && (
            <div className="w-full aspect-video rounded-lg overflow-hidden bg-card border border-border/30">
              <img src={item.thumbnailSrc ?? item.filePath} alt="" className="w-full h-full object-cover" />
            </div>
          )}

          <div className="flex flex-col gap-3">
            <MetaRow label="ASSET_ID">{item.id}</MetaRow>
            <MetaRow label="TYPE">
              <span className="flex items-center gap-1.5">
                <TypeIcon className="w-3.5 h-3.5 text-primary/60" />
                {item.type.toUpperCase()}
              </span>
            </MetaRow>
            <MetaRow label="COMMITS">{loading ? '...' : commits.length}</MetaRow>
          </div>

          {/* Active version card */}
          {headCommit && headOp && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 shadow-[0_0_12px_rgba(0,212,255,0.08)]">
              <span className="text-[10px] font-mono font-bold tracking-widest text-primary/50 uppercase">ACTIVE_VER</span>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-sm font-mono text-primary/90 font-bold">{headCommit.hash.slice(0, 7)}</span>
                <span className={cn('text-xs font-mono', OPERATION_STYLES[headOp].label)}>{headOp}</span>
              </div>
            </div>
          )}
        </div>

        {/* Right panel — commit log */}
        <div className="flex-1 flex flex-col min-h-0 px-5 py-5">
          <div className="flex items-baseline gap-3 mb-4 shrink-0">
            <span className="text-xs font-mono font-bold tracking-widest text-muted-foreground/70 uppercase">COMMIT_LOG</span>
            <span className="text-[11px] font-mono text-muted-foreground/40">&middot; {loading ? '...' : commits.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground/50 py-4 pl-[15px]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading history...
              </div>
            ) : commits.length === 0 ? (
              <div className="text-sm font-mono text-muted-foreground/40 py-4 pl-[15px]">
                No history found
              </div>
            ) : (
              commits.map((commit, i) => (
                <TimelineNode key={commit.hash} commit={commit} isHead={i === 0} onRestore={handleRestore} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

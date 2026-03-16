import { useEffect } from 'react';
import { History, RotateCcw, Film, ImageIcon, Music, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import type { UseMcpResult } from 'use-mcp/react';
import { useAssetHistory, type GitCommit } from '@/hooks/useAssetHistory';
import type { MediaItem } from '@/components/sidebar/types';

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

const TYPE_ICONS: Record<string, typeof Film> = {
  video: Film,
  final: Film,
  image: ImageIcon,
  audio: Music,
  script: FileText,
  plan: FileText,
};

const pixelGridStyle = {
  backgroundImage:
    'linear-gradient(rgba(0, 255, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 255, 255, 0.1) 1px, transparent 1px)',
  backgroundSize: '4px 4px',
};

function CopyableText({ text, display }: { text: string; display?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        toast({ title: 'Copied', description: text, duration: 2000 });
      }}
      className="font-mono hover:underline hover:text-cyan-400 transition-colors cursor-pointer"
    >
      {display ?? text}
    </button>
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
      <div className="absolute left-[15px] top-0 bottom-0 w-px bg-cyan-400/20" />
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
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className={cn('text-xs font-mono font-bold', style.label)}>{op}</span>
            <CopyableText text={commit.hash} display={commit.hash.slice(0, 7)} />
          </div>
          <span className="text-[11px] font-mono text-muted-foreground/50 shrink-0">{formatDate(commit.date)}</span>
        </div>
        {commit.files && commit.files.length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
            {commit.files.map((file) => (
              <span key={file} className="text-[10px] font-mono text-muted-foreground/40">{file}</span>
            ))}
          </div>
        )}
        {!isHead && (
          <button
            onClick={() => onRestore(commit.hash)}
            className="opacity-0 group-hover:opacity-100 flex items-center gap-1 mt-1 px-0 py-0.5 text-[10px] font-mono font-bold tracking-wider text-muted-foreground/50 hover:text-cyan-400 transition-all uppercase bg-transparent border-none cursor-pointer w-fit"
          >
            <RotateCcw className="w-3 h-3" />
            Rewind
          </button>
        )}
      </div>
    </div>
  );
}

interface GitHistoryPanelProps {
  item: MediaItem;
  projectSlug: string;
  callTool: UseMcpResult['callTool'];
}

export function GitHistoryPanel({ item, projectSlug, callTool }: GitHistoryPanelProps) {
  const { commits, loading, fetchHistory, restoreVersion } = useAssetHistory(callTool);

  useEffect(() => {
    fetchHistory(item.id, projectSlug);
  }, [item.id, projectSlug, fetchHistory]);

  const handleRestore = async (hash: string) => {
    const ok = await restoreVersion(item.id, hash, projectSlug);
    if (ok) fetchHistory(item.id, projectSlug);
  };

  const TypeIcon = TYPE_ICONS[item.type] ?? FileText;

  return (
    <div
      className={cn(
        'relative w-full h-full overflow-hidden',
        'bg-gradient-to-b from-cyan-950/30 via-black to-black'
      )}
    >
      {/* Scanlines overlay */}
      <div className="absolute inset-0 pointer-events-none scanlines opacity-20 z-10" />
      {/* Pixel grid */}
      <div className="absolute inset-0 pointer-events-none opacity-5" style={pixelGridStyle} />

      {/* Corner accent SVGs */}
      <svg
        className="absolute top-0 left-0 w-6 h-6 text-primary/30 z-30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      >
        <path d="M0 12 L12 0" />
        <path d="M0 6 L6 0" />
      </svg>
      <svg
        className="absolute bottom-0 right-0 w-6 h-6 text-primary/30 z-30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      >
        <path d="M24 12 L12 24" />
        <path d="M24 18 L18 24" />
      </svg>

      {/* Content frame */}
      <div
        className={cn(
          'relative z-20 h-full flex flex-col',
          'border-2 border-cyan-400/50',
          'clip-corner-both',
          'shadow-[0_0_30px_-10px_rgba(0,255,255,0.3)]'
        )}
      >
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-3 px-4 py-2 shrink-0',
            'border-b-2 border-inherit',
            'bg-black/50 backdrop-blur-sm'
          )}
        >
          <History className="w-3.5 h-3.5 text-cyan-400 drop-shadow-[0_0_6px_#22d3ee]" />
          <span className="text-xs font-bold tracking-[0.15em] text-cyan-400">HISTORY</span>
          <span className="text-[10px] font-mono text-muted-foreground/50 mx-1">//</span>
          <span className="text-[11px]"><CopyableText text={item.id} /></span>
          <span className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground/40 ml-1">
            <TypeIcon className="w-3 h-3" />
            {item.type.toUpperCase()}
          </span>
          <span className="text-[11px] font-mono text-muted-foreground/40">
            {loading ? '...' : `${commits.length} commits`}
          </span>
        </div>

        {/* Timeline */}
        <div className="flex-1 min-h-0 overflow-y-auto pl-8 pr-8 py-4 pb-6">
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
  );
}

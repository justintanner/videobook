import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronDown, RotateCcw, RefreshCw, FileText, Check, VideoOff, Zap, Copy, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { MediaItem } from '@/components/sidebar/types';
import type { Orientation } from '@/hooks/useTimeline';
import { CommandButton } from '@/components/commands';
import type { UseMcpResult } from 'use-mcp/react';
import { useAssetHistory } from '@/hooks/useAssetHistory';
import { HistoryListPane, HistoryDetailPane, HistoryEmptyState } from './GitHistoryPanel';
import type { GitCommit } from '@/hooks/useAssetHistory';
import { JsonNode } from '@/components/ui/JsonNode';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  type ViewerSize,
  type BackTab,
  type ManifestFile,
  isBinaryFile,
  isImageFile,
  formatBytes,
  ratioLabel,
  ratioIcons,
} from './viewer-types';

export type { ViewerSize, BackTab, ManifestFile } from './viewer-types';

// ── Leaf Components ──

export function CropImage({ cropSrc, fallbackSrc, alt }: { cropSrc: string; fallbackSrc: string; alt: string }) {
  const fell = useRef(false);
  const [src, setSrc] = useState(cropSrc);

  return (
    <img
      src={src}
      alt={alt}
      className="w-full h-full object-contain"
      draggable={false}
      onError={() => {
        if (!fell.current) {
          fell.current = true;
          setSrc(fallbackSrc);
        }
      }}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const mdComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-lg font-bold text-primary mt-4 mb-2 font-mono uppercase tracking-wider">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-base font-bold text-primary/90 mt-3 mb-1.5 font-mono">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-sm font-bold text-primary/80 mt-2 mb-1 font-mono">{children}</h3>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="text-sm leading-relaxed text-primary/70 mb-3">{children}</p>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="text-primary font-bold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="text-primary/80 italic">{children}</em>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="text-sm text-primary/70 pl-5 mb-2 list-disc">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="text-sm text-primary/70 pl-5 mb-2 list-decimal">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="mb-0.5">{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="border-l-2 border-primary/40 pl-3 text-primary/60 italic my-2">{children}</blockquote>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    className
      ? <code className="block font-mono text-xs bg-black/60 text-primary/80 p-3 rounded border border-zinc-800/40 overflow-x-auto mb-3">{children}</code>
      : <code className="font-mono text-xs bg-primary/10 text-primary/90 px-1 py-0.5 rounded">{children}</code>,
  hr: () => <hr className="border-zinc-700/50 my-4" />,
};

export function ScriptContent({ item }: { item: MediaItem }) {
  if (!item.prompt) {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <FileText className="w-16 h-16 text-primary/20" />
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-y-auto p-6">
      <div className="max-w-lg mx-auto">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {item.prompt}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export function RenderPrompt({ item, orientation, onRender }: {
  item: MediaItem;
  orientation: Orientation;
  onRender?: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const isFinal = item.type === 'final';
  const primaryColor = isFinal ? '#fbbf24' : 'var(--color-primary)';

  const handleClick = () => {
    if (armed) {
      onRender?.();
      setArmed(false);
    } else {
      setArmed(true);
    }
  };

  return (
    <div className="w-full h-full bg-black flex flex-col items-center justify-center relative overflow-hidden select-none">
      {/* CRT scanlines */}
      <div className="absolute inset-0 scanlines pointer-events-none opacity-50" />

      {/* Pixel grid */}
      <div
        className="absolute inset-0 pointer-events-none opacity-15"
        style={{
          backgroundImage: `linear-gradient(${primaryColor}33 1px, transparent 1px), linear-gradient(90deg, ${primaryColor}33 1px, transparent 1px)`,
          backgroundSize: '8px 8px',
        }}
      />

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        <VideoOff className="w-10 h-10" style={{ color: `${primaryColor}30` }} />

        {/* CommandButton */}
        <CommandButton
          command={armed ? '/yes' : `/render ${orientation}`}
          icon={<Zap className="w-5 h-5" />}
          size="lg"
          state={armed ? 'ready' : undefined}
          className={isFinal
            ? 'border-amber-400 bg-amber-500/20 text-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.3)]'
            : undefined}
          onClick={handleClick}
        />
      </div>
    </div>
  );
}

export function RatioToggle({ active, onSelect, item, sizes: sizesProp }: {
  active: ViewerSize;
  onSelect: (s: ViewerSize) => void;
  item?: MediaItem;
  sizes?: ViewerSize[];
}) {
  const sizes = sizesProp ?? ['original', 'landscape', 'portrait', 'square'];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          tabIndex={-1}
          className="h-8 px-3 flex items-center gap-1 font-mono text-[13px] font-bold text-cyan-400 relative transition-all duration-[120ms] hover:text-white"
          style={{ background: 'rgba(0,217,255,0.06)' }}
        >
          {ratioLabel(active, item)}
          <ChevronDown className="w-3 h-3" />
          <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {sizes.map((size) => {
          const Icon = ratioIcons[size];
          const isActive = active === size;
          return (
            <DropdownMenuItem key={size} onClick={() => onSelect(size)} className="py-2.5">
              <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">
                {isActive ? <Check className="w-3 h-3 inline text-primary" /> : '\u203A'}
              </span>
              <span className={cn('font-mono font-bold text-xs tracking-wider leading-none flex-1', !isActive && 'text-muted-foreground/60')}>
                {ratioLabel(size, item)}
              </span>
              <span className={cn('ml-2 flex items-center', !isActive && 'opacity-40')}>
                <Icon className="h-3 w-3" />
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function JsonTerminal({ data, loading }: { data: string | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-xs text-muted-foreground/50 font-mono">Loading...</p>
      </div>
    );
  }
  if (data === null) {
    return <p className="text-sm text-muted-foreground/50 font-mono text-center py-8">No data found.</p>;
  }
  if (data.startsWith('Error:')) {
    return <p className="text-sm font-mono" style={{ color: '#ff4060' }}>{data}</p>;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return <pre className="text-base font-mono text-foreground/80 whitespace-pre-wrap break-all">{data}</pre>;
  }

  return (
    <pre className="text-base font-mono leading-relaxed whitespace-pre-wrap break-all">
      <JsonNode data={parsed} />
    </pre>
  );
}

export function FileListPane({ files, selectedFile, onSelectFile, onRefresh, loading }: {
  files: ManifestFile[];
  selectedFile: string;
  onSelectFile: (name: string) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-mono text-muted-foreground/50 uppercase tracking-wider">
          {loading ? '...' : `${files.length} files`}
        </span>
        <button
          tabIndex={-1}
          onClick={onRefresh}
          className="w-6 h-6 flex items-center justify-center text-muted-foreground/60 hover:text-primary transition-colors"
        >
          <RefreshCw className={cn('w-4 h-4 stroke-[2.5]', loading && 'animate-spin')} />
        </button>
      </div>
      {files.map((f) => (
        <button
          key={f.name}
          tabIndex={-1}
          onClick={() => onSelectFile(f.name)}
          className={cn(
            'w-full text-left px-3 py-2 text-sm font-mono flex items-center gap-2 transition-colors',
            selectedFile === f.name
              ? 'bg-primary/10 border-l-2 border-primary text-primary'
              : 'border-l-2 border-transparent hover:bg-white/5',
            f.name.startsWith('.') && selectedFile !== f.name && 'text-muted-foreground/40',
          )}
        >
          <span className="truncate flex-1">{f.name}</span>
          <span className="text-xs text-muted-foreground/30 shrink-0">{formatBytes(f.size_bytes)}</span>
        </button>
      ))}
    </div>
  );
}

export function FileContentPane({ content, loading, fileName, fileUrl }: {
  content: string | null;
  loading: boolean;
  fileName: string;
  fileUrl: string;
}) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-8">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        <p className="text-xs text-muted-foreground/50 font-mono">Loading...</p>
      </div>
    );
  }

  if (isImageFile(fileName)) {
    return (
      <div className="flex items-center justify-center h-full">
        <img src={fileUrl} alt={fileName} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }

  if (isBinaryFile(fileName)) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground/50">
        <p className="text-sm font-mono">Binary file</p>
        <p className="text-xs font-mono">{fileName}</p>
      </div>
    );
  }

  const isJson = fileName.endsWith('.json');
  if (isJson) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (content) {
              navigator.clipboard.writeText(content);
              toast({ title: 'Copied', description: fileName, duration: 2000 });
            }
          }}
          className="absolute top-0 right-0 w-7 h-7 flex items-center justify-center text-muted-foreground/60 hover:text-white transition-colors"
        >
          <Copy className="w-5 h-5 stroke-[2]" />
        </button>
        <JsonTerminal data={content} loading={false} />
      </div>
    );
  }

  if (content === null) {
    return <p className="text-sm text-muted-foreground/50 font-mono text-center py-8">No data found.</p>;
  }

  return (
    <pre className="text-sm font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">{content}</pre>
  );
}

// ── Composable Viewer Components ──

export function ViewerToolbar({ left, slug, right }: {
  left: React.ReactNode;
  slug: string;
  right: React.ReactNode;
}) {
  return (
    <div className="shrink-0 px-3 py-3 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
      {left}
      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{slug}</span>
      </span>
      {right}
    </div>
  );
}

export function BackFaceTabBar({ tabs, active, onSelect, slug, onClose, onCloseViewer }: {
  tabs: BackTab[];
  active: BackTab;
  onSelect: (t: BackTab) => void;
  slug: string;
  onClose: () => void;
  onCloseViewer?: () => void;
}) {
  return (
    <div className="shrink-0 px-3 py-3 flex items-center justify-between relative bg-black/60 border-b border-zinc-800/60">
      <div className="flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            tabIndex={-1}
            onClick={() => onSelect(tab)}
            className={cn(
              'h-8 px-3 flex items-center font-mono text-[13px] font-bold transition-all duration-[120ms] relative',
              active === tab ? 'text-cyan-400' : 'text-muted-foreground hover:text-white/70',
            )}
            style={{ background: active === tab ? 'rgba(0,217,255,0.06)' : 'transparent' }}
          >
            <span>/{tab}</span>
            {active === tab && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />}
          </button>
        ))}
      </div>
      <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{slug}</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          tabIndex={-1}
          onClick={onClose}
          title="Back"
          className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
        >
          <RotateCcw className="w-4 h-4 stroke-[2.5]" />
        </button>
        {onCloseViewer && (
          <button
            tabIndex={-1}
            onClick={onCloseViewer}
            title="Close"
            className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
          >
            <X className="w-4 h-4 stroke-[2.5]" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Back Face Content Panes ──

export function FilesBackPane({ manifest, manifestLoading, selectedFile, fileContent, fileLoading, fileUrl, handleSelectFile, handleFileKeyDown, fetchManifest, fetchFileContent }: {
  manifest: ManifestFile[] | null;
  manifestLoading: boolean;
  selectedFile: string;
  fileContent: string | null;
  fileLoading: boolean;
  fileUrl: string;
  handleSelectFile: (name: string) => void;
  handleFileKeyDown: (e: React.KeyboardEvent) => void;
  fetchManifest: () => void;
  fetchFileContent: (name: string) => void;
}) {
  return (
    <div className="flex-1 flex min-h-0">
      <div
        data-tabstop="files"
        tabIndex={0}
        onKeyDown={handleFileKeyDown}
        className="w-[280px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40 outline-none focus:ring-1 focus:ring-primary/40"
      >
        <FileListPane
          files={manifest ?? []}
          selectedFile={selectedFile}
          onSelectFile={handleSelectFile}
          onRefresh={() => { fetchManifest(); fetchFileContent(selectedFile); }}
          loading={manifestLoading}
        />
      </div>
      <div className="flex-1 overflow-auto p-4 bg-black">
        <FileContentPane
          content={fileContent}
          loading={fileLoading}
          fileName={selectedFile}
          fileUrl={fileUrl}
        />
      </div>
    </div>
  );
}

export function HistoryBackPane({ commits, historyLoading, selectedCommitHash, setSelectedCommitHash, handleRestore, fetchHistory, itemId, projectSlug }: {
  commits: GitCommit[];
  historyLoading: boolean;
  selectedCommitHash: string | null;
  setSelectedCommitHash: (hash: string | null) => void;
  handleRestore: (hash: string) => Promise<void>;
  fetchHistory: (itemId: string, projectSlug: string) => void;
  itemId: string;
  projectSlug: string;
}) {
  if (commits.length === 0) {
    return (
      <div className="flex-1 bg-black">
        <HistoryEmptyState loading={historyLoading} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-[340px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40">
        <HistoryListPane
          commits={commits}
          selectedHash={selectedCommitHash}
          onSelectCommit={setSelectedCommitHash}
          onRefresh={() => fetchHistory(itemId, projectSlug)}
          loading={historyLoading}
        />
      </div>
      <div className="flex-1 overflow-auto bg-black">
        <HistoryDetailPane
          commit={commits.find(c => c.hash === selectedCommitHash) ?? null}
          isHead={selectedCommitHash === commits[0]?.hash}
          onRestore={handleRestore}
        />
      </div>
    </div>
  );
}

// ── useViewerBackFace Hook ──

// eslint-disable-next-line react-refresh/only-export-components
export function useViewerBackFace({ projectSlug, itemId, callTool, flipped, onFlippedChange, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, defaultBackTab }: {
  projectSlug: string;
  itemId: string;
  callTool: UseMcpResult['callTool'];
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  defaultBackTab: BackTab;
}) {
  const [backTab, setBackTab] = useState<BackTab>(defaultBackTab);
  const [manifest, setManifest] = useState<ManifestFile[] | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState('.original.json');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const { commits, loading: historyLoading, fetchHistory, restoreVersion } = useAssetHistory(callTool);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);

  const fileUrl = useMemo(
    () => `/files/${projectSlug}/${itemId}/${selectedFile}`,
    [projectSlug, itemId, selectedFile],
  );

  const fetchFileContent = useCallback(async (fileName: string) => {
    if (isBinaryFile(fileName)) {
      setFileContent(null);
      return;
    }
    setFileLoading(true);
    try {
      const res = await fetch(`/files/${projectSlug}/${itemId}/${fileName}`);
      if (res.ok) {
        const text = await res.text();
        if (fileName.endsWith('.json')) {
          try {
            setFileContent(JSON.stringify(JSON.parse(text), null, 2));
          } catch {
            setFileContent(text);
          }
        } else {
          setFileContent(text);
        }
      } else {
        setFileContent(`Error: ${res.status} ${res.statusText}`);
      }
    } catch (e) {
      setFileContent(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFileLoading(false);
    }
  }, [projectSlug, itemId]);

  const fetchManifest = useCallback(async () => {
    setManifestLoading(true);
    try {
      const res = await fetch(`/api/manifest/${projectSlug}/${itemId}`);
      if (res.ok) {
        const data = await res.json();
        setManifest(data.files as ManifestFile[]);
      } else {
        setManifest([]);
      }
    } catch {
      setManifest([]);
    } finally {
      setManifestLoading(false);
    }
  }, [projectSlug, itemId]);

  const pendingFocusRef = useRef<number | undefined>(undefined);

  // Reset on item change
  useEffect(() => {
    onFlippedChange(false);
    setBackTab(defaultBackTab);
    setManifest(null);
    setSelectedFile('.original.json');
    setFileContent(null);
    setSelectedCommitHash(null);
  }, [itemId, onFlippedChange, defaultBackTab]);

  // Fetch manifest when files tab is active
  useEffect(() => {
    if (flipped && backTab === 'files' && !manifestLoading) {
      fetchManifest();
      fetchFileContent('.original.json');
    }
  }, [flipped, backTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch history when history tab is active
  useEffect(() => {
    if (flipped && backTab === 'history') {
      fetchHistory(itemId, projectSlug);
    }
  }, [flipped, backTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select latest commit
  useEffect(() => {
    if (commits.length > 0 && selectedCommitHash === null) {
      setSelectedCommitHash(commits[0].hash);
    }
  }, [commits, selectedCommitHash]);

  const handleRestore = async (hash: string) => {
    const ok = await restoreVersion(itemId, hash, projectSlug);
    if (ok) fetchHistory(itemId, projectSlug);
  };

  // Apply pending focus once manifest loads
  useEffect(() => {
    if (pendingFocusRef.current === undefined || !manifest || manifest.length === 0) return;
    const idx = Math.max(0, Math.min(pendingFocusRef.current - 1, manifest.length - 1));
    const fileName = manifest[idx].name;
    pendingFocusRef.current = undefined;
    setSelectedFile(fileName);
    setFileContent(null);
    fetchFileContent(fileName);
    document.querySelector<HTMLElement>('[data-tabstop="files"]')?.focus();
  }, [manifest, fetchFileContent]);

  const handleFlipToBack = () => {
    setBackTab(defaultBackTab);
    onFlippedChange(true);
  };

  // Handle pending file position
  useEffect(() => {
    if (pendingFilePosition == null) return;
    pendingFocusRef.current = pendingFilePosition;
    setBackTab('files');
    onFlippedChange(true);
    if (manifest === null) {
      fetchManifest();
    } else {
      const idx = Math.max(0, Math.min(pendingFilePosition - 1, manifest.length - 1));
      const fileName = manifest[idx].name;
      pendingFocusRef.current = undefined;
      setSelectedFile(fileName);
      setFileContent(null);
      fetchFileContent(fileName);
      document.querySelector<HTMLElement>('[data-tabstop="files"]')?.focus();
    }
    onClearPendingFilePosition?.();
  }, [pendingFilePosition]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle pending back tab
  useEffect(() => {
    if (pendingBackTab == null) return;
    // Non-video viewers don't have settings tab
    if (pendingBackTab === 'settings' && defaultBackTab !== 'settings') {
      setBackTab('files');
    } else {
      setBackTab(pendingBackTab);
    }
    onClearPendingBackTab?.();
  }, [pendingBackTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectFile = useCallback((fileName: string) => {
    setSelectedFile(fileName);
    setFileContent(null);
    fetchFileContent(fileName);
  }, [fetchFileContent]);

  const handleFileKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!manifest || manifest.length === 0) return;
    const idx = manifest.findIndex(f => f.name === selectedFile);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (idx + 1) % manifest.length;
      handleSelectFile(manifest[next].name);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (idx - 1 + manifest.length) % manifest.length;
      handleSelectFile(manifest[prev].name);
    } else if (e.key === 'Tab') {
      const input = document.querySelector<HTMLElement>('[data-testid="input-chat"]');
      if (input) {
        e.preventDefault();
        input.focus();
      }
    }
  }, [manifest, selectedFile, handleSelectFile]);

  return {
    backTab,
    setBackTab,
    manifest,
    manifestLoading,
    selectedFile,
    fileContent,
    fileLoading,
    fileUrl,
    handleSelectFile,
    handleFileKeyDown,
    commits,
    historyLoading,
    selectedCommitHash,
    setSelectedCommitHash,
    handleRestore,
    handleFlipToBack,
    fetchManifest,
    fetchFileContent,
    fetchHistory,
  };
}

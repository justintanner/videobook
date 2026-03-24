import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Settings, ChevronDown, RotateCcw, RefreshCw, AudioLines, FileText, Monitor, Smartphone, Square, Check, VideoOff, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { MediaItem } from '@/components/sidebar/types';
import type { Orientation } from '@/hooks/useTimeline';
import { CommandButton } from '@/components/commands';
import { RenderingReadout } from './RenderingReadout';
import { RenderSettingsPanel } from './RenderSettingsPanel';
import type { RenderSettings } from './render-settings-types';
import { useMountKey } from '@/contexts/MountKeyContext';
import type { UseMcpResult } from 'use-mcp/react';
import { useAssetHistory } from '@/hooks/useAssetHistory';
import { HistoryListPane, HistoryDetailPane, HistoryEmptyState } from './GitHistoryPanel';
import { JsonNode } from '@/components/ui/JsonNode';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

function CropImage({ cropSrc, fallbackSrc, alt }: { cropSrc: string; fallbackSrc: string; alt: string }) {
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

function ImageViewer({ item, size }: { item: MediaItem; size: ViewerSize }) {
  if (item.type === 'image') {
    if (!item.filePath) return null;
    if (size === 'original') {
      return (
        <img
          src={item.filePath}
          alt={item.title}
          className="w-full h-full object-contain"
          draggable={false}
        />
      );
    }
    const cropFile = size === 'landscape' ? 'landscape.jpg'
      : size === 'portrait' ? 'portrait.jpg'
      : 'square.jpg';
    const cropSrc = item.filePath.replace(/\/[^/]+$/, `/${cropFile}`);
    return (
      <CropImage key={cropSrc} cropSrc={cropSrc} fallbackSrc={item.filePath} alt={item.title} />
    );
  }

  if (item.type === 'audio') {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <AudioLines className="w-16 h-16 text-primary/30" />
      </div>
    );
  }

  if (item.type === 'script' || item.type === 'plan') {
    return <ScriptViewer item={item} />;
  }

  return null;
}

const mdComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-lg font-bold text-primary/80 mt-4 mb-2 font-mono uppercase tracking-wider">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-base font-bold text-primary/60 mt-3 mb-1.5 font-mono">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-sm font-bold text-primary/50 mt-2 mb-1 font-mono">{children}</h3>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="text-sm leading-relaxed text-primary/40 mb-3">{children}</p>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="text-primary/70 font-bold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="text-primary/50 italic">{children}</em>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="text-sm text-primary/40 pl-5 mb-2 list-disc">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="text-sm text-primary/40 pl-5 mb-2 list-decimal">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="mb-0.5">{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="border-l-2 border-primary/20 pl-3 text-primary/30 italic my-2">{children}</blockquote>,
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    className
      ? <code className="block font-mono text-xs bg-black/60 text-primary/50 p-3 rounded border border-zinc-800/40 overflow-x-auto mb-3">{children}</code>
      : <code className="font-mono text-xs bg-primary/5 text-primary/60 px-1 py-0.5 rounded">{children}</code>,
  hr: () => <hr className="border-zinc-700/30 my-4" />,
};

function ScriptViewer({ item }: { item: MediaItem }) {
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

function ClipContent({ item, size, onRender }: {
  item: MediaItem;
  size: ViewerSize;
  onRender?: () => void;
}) {
  if (!item.filePath) return null;

  if (size === 'original') {
    const thumbSrc = item.thumbnailSrc || item.filePath.replace(/\/[^/]+$/, '/original.jpg');
    return <video key={item.filePath} src={item.filePath} poster={thumbSrc} controls tabIndex={-1} className="w-full h-full object-contain" draggable={false} />;
  }

  const orient = size as Orientation;
  const renders = item.renders ?? [];
  const status = item.status;

  if (renders.includes(orient)) {
    const orientedFile = size === 'landscape' ? 'landscape.mp4'
      : size === 'portrait' ? 'portrait.mp4'
      : 'square.mp4';
    const qIdx = item.filePath.indexOf('?');
    const qs = qIdx >= 0 ? item.filePath.slice(qIdx) : '';
    const basePath = qIdx >= 0 ? item.filePath.slice(0, qIdx) : item.filePath;
    const derivedSrc = basePath.replace(/\/[^/]+$/, `/${orientedFile}`) + qs;
    const thumbFile = size === 'landscape' ? 'landscape.jpg'
      : size === 'portrait' ? 'portrait.jpg'
      : 'square.jpg';
    const thumbSrc = basePath.replace(/\/[^/]+$/, `/${thumbFile}`) + qs;
    return <video key={derivedSrc} src={derivedSrc} poster={thumbSrc} controls tabIndex={-1} className="w-full h-full object-contain" draggable={false} />;
  }

  if (status && RENDERING_STATUSES.has(status)) {
    return <RenderingReadout asset={item} />;
  }

  return <RenderPrompt item={item} orientation={orient} onRender={onRender} />;
}

function ratioLabel(size: ViewerSize, item?: MediaItem): string {
  switch (size) {
    case 'original':
      return item?.width && item?.height ? `/original ${item.width}x${item.height}` : '/original';
    case 'landscape':
      return '/landscape 1920x1080';
    case 'portrait':
      return '/portrait 1080x1920';
    case 'square':
      return '/square 1080x1080';
  }
}

const ratioIcons: Record<ViewerSize, typeof Monitor> = {
  original: Monitor,
  landscape: Monitor,
  portrait: Smartphone,
  square: Square,
};

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
        <button tabIndex={-1} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold text-primary/70 hover:text-primary hover:bg-primary/10 transition-colors">
          {ratioLabel(active, item)}
          <ChevronDown className="w-3 h-3" />
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

const RENDERING_STATUSES = new Set<string>([
  'rendering', 'rendering-landscape', 'rendering-portrait', 'rendering-square',
  'render-queued', 'render-queued-landscape', 'render-queued-portrait', 'render-queued-square',
]);

type BackTab = 'settings' | 'files' | 'history';

function SettingsPane({ item, renderOrientation, onSizeChange, onRender, settings, onSettingsChange }: {
  item: MediaItem;
  renderOrientation: Orientation;
  onSizeChange: (s: ViewerSize) => void;
  onRender?: (settings: RenderSettings) => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings | ((prev: RenderSettings) => RenderSettings)) => void;
}) {
  const isClip = item.type === 'video' || item.type === 'final';
  const allOrientations: Orientation[] = ['landscape', 'portrait', 'square'];

  const orientationEntries = allOrientations.map((orient) => ({
    orient,
    active: orient === renderOrientation,
  }));

  const handleApply = () => {
    onRender?.(settings);
  };

  if (!isClip) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground/50 font-mono">No render settings for this asset type</p>
      </div>
    );
  }

  const handleClick = (orient: Orientation) => {
    onSizeChange(orient);
  };

  const subtitleFieldMap: Record<string, keyof RenderSettings> = {
    enabled: 'subtitlesEnabled',
    style: 'subtitleStyle',
    position: 'subtitlePosition',
    fontSize: 'fontSize',
    textColor: 'textColor',
    highlightColor: 'highlightColor',
    strokeWidth: 'strokeWidth',
    strokeColor: 'strokeColor',
    shadowBlur: 'shadowBlur',
    shadowOpacity: 'shadowOpacity',
  };

  const handleSubtitleChange = (field: string, value: string | boolean | number) => {
    const key = subtitleFieldMap[field] ?? field;
    onSettingsChange({ ...settings, [key]: value });
  };

  const handleOsgChange = (field: string, value: string | boolean | null) => {
    const keyMap: Record<string, keyof RenderSettings> = {
      position: 'osgPosition',
      assetId: 'osgAssetId',
      assetSrc: 'osgAssetSrc',
    };
    const key = keyMap[field] ?? field;
    onSettingsChange(prev => ({ ...prev, [key]: value }));
  };

  const handleAudioChange = (field: string, value: number) => {
    onSettingsChange({ ...settings, [field]: value });
  };

  const handleBackgroundChange = (mode: 'blur' | 'black') => {
    onSettingsChange({ ...settings, backgroundMode: mode });
  };

  return (
    <RenderSettingsPanel
      orientations={orientationEntries}
      onOrientationClick={handleClick}
      subtitlesEnabled={settings.subtitlesEnabled}
      subtitleStyle={settings.subtitleStyle}
      subtitlePosition={settings.subtitlePosition}
      fontSize={settings.fontSize}
      textColor={settings.textColor}
      highlightColor={settings.highlightColor}
      strokeWidth={settings.strokeWidth}
      strokeColor={settings.strokeColor}
      shadowBlur={settings.shadowBlur}
      shadowOpacity={settings.shadowOpacity}
      onSubtitleChange={handleSubtitleChange}
      audioVolume={settings.audioVolume}
      audioFadeIn={settings.audioFadeIn}
      audioFadeOut={settings.audioFadeOut}
      onAudioChange={handleAudioChange}
      osgAssetId={settings.osgAssetId}
      osgAssetSrc={settings.osgAssetSrc}
      osgPosition={settings.osgPosition}
      onOsgChange={handleOsgChange}
      backgroundMode={settings.backgroundMode}
      onBackgroundChange={handleBackgroundChange}
      onApply={handleApply}
    />
  );
}

function JsonTerminal({ data, loading }: { data: string | null; loading: boolean }) {
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
    return <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">{data}</pre>;
  }

  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
      <JsonNode data={parsed} />
    </pre>
  );
}

export type ManifestFile = { name: string; size_bytes: number; extension: string | null };

const BINARY_EXTENSIONS = new Set(['mp4', 'mp3', 'wav', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'mov', 'flac', 'aac', 'ogg']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function isBinaryFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
      <div className="flex items-center justify-end px-3 py-1">
        <button
          tabIndex={-1}
          onClick={onRefresh}
          className="w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors"
        >
          <RefreshCw className={cn('w-3 h-3 stroke-[2.5]', loading && 'animate-spin')} />
        </button>
      </div>
      {files.map((f) => (
        <button
          key={f.name}
          tabIndex={-1}
          onClick={() => onSelectFile(f.name)}
          className={cn(
            'w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 transition-colors',
            selectedFile === f.name
              ? 'bg-primary/10 border-l-2 border-primary text-primary'
              : 'border-l-2 border-transparent hover:bg-white/5',
            f.name.startsWith('.') && selectedFile !== f.name && 'text-muted-foreground/40',
          )}
        >
          <span className="truncate flex-1">{f.name}</span>
          <span className="text-[10px] text-muted-foreground/30 shrink-0">{formatBytes(f.size_bytes)}</span>
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

  // Text file — use JsonTerminal for .json, plain pre for everything else
  const isJson = fileName.endsWith('.json');
  if (isJson) {
    return <JsonTerminal data={content} loading={false} />;
  }

  if (content === null) {
    return <p className="text-sm text-muted-foreground/50 font-mono text-center py-8">No data found.</p>;
  }

  return (
    <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">{content}</pre>
  );
}

export function AssetViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange, renderOrientation, onRender, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, settings, onSettingsChange, callTool }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  renderOrientation: Orientation;
  onRender?: (settings?: RenderSettings) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  settings: RenderSettings;
  onSettingsChange: (s: RenderSettings | ((prev: RenderSettings) => RenderSettings)) => void;
  callTool: UseMcpResult['callTool'];
}) {
  useMountKey('viewer');
  const isClip = item.type === 'video' || item.type === 'final';
  const isText = item.type === 'script' || item.type === 'plan';
  const [backTab, setBackTab] = useState<BackTab>('settings');
  const [manifest, setManifest] = useState<ManifestFile[] | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState('.original.json');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // History tab state
  const { commits, loading: historyLoading, fetchHistory, restoreVersion } = useAssetHistory(callTool);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);

  const fileUrl = useMemo(
    () => `/files/${projectSlug}/${item.id}/${selectedFile}`,
    [projectSlug, item.id, selectedFile],
  );

  const fetchFileContent = useCallback(async (fileName: string) => {
    if (isBinaryFile(fileName)) {
      setFileContent(null);
      return;
    }
    setFileLoading(true);
    try {
      const res = await fetch(`/files/${projectSlug}/${item.id}/${fileName}`);
      if (res.ok) {
        const text = await res.text();
        // Re-format JSON for pretty display
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
  }, [projectSlug, item.id]);

  const fetchManifest = useCallback(async () => {
    setManifestLoading(true);
    try {
      const res = await fetch(`/api/manifest/${projectSlug}/${item.id}`);
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
  }, [projectSlug, item.id]);

  const pendingFocusRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    onFlippedChange(false);
    setBackTab('settings');
    setManifest(null);
    setSelectedFile('.original.json');
    setFileContent(null);
    setSelectedCommitHash(null);
  }, [item.id, onFlippedChange]);

  // Fetch manifest when files tab is active on the back face
  useEffect(() => {
    if (flipped && backTab === 'files' && !manifestLoading) {
      fetchManifest();
      fetchFileContent('.original.json');
    }
  }, [flipped, backTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch history when history tab is active on the back face
  useEffect(() => {
    if (flipped && backTab === 'history') {
      fetchHistory(item.id, projectSlug);
    }
  }, [flipped, backTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select the latest commit when history loads
  useEffect(() => {
    if (commits.length > 0 && selectedCommitHash === null) {
      setSelectedCommitHash(commits[0].hash);
    }
  }, [commits, selectedCommitHash]);

  const handleRestore = async (hash: string) => {
    const ok = await restoreVersion(item.id, hash, projectSlug);
    if (ok) fetchHistory(item.id, projectSlug);
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
    setBackTab('settings');
    onFlippedChange(true);
  };

  // Handle pending file position from uiAction dispatch
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

  // Handle pending back tab from uiAction dispatch
  useEffect(() => {
    if (pendingBackTab == null) return;
    setBackTab(pendingBackTab);
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

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'flip-card-perspective',
          isText ? 'w-full h-full'
            : size === 'original' ? 'w-full h-full'
            : size === 'landscape' ? 'aspect-video w-full h-full'
            : size === 'square' ? 'aspect-square w-full h-full'
            : 'w-full h-full',
        )}
      >
        <div className={cn(
          'flip-card-inner w-full h-full relative',
          flipped && 'flipped',
        )}>
          {/* FRONT FACE */}
          <div className={cn(
            'flip-card-face absolute inset-0 flex flex-col overflow-hidden',
            'border border-zinc-600/50',
          )}>
            {/* Top bar */}
            <div className="shrink-0 px-3 py-3 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
              {isText ? (
                <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-primary/70">
                  <FileText className="w-3.5 h-3.5" />
                  <span>Markdown</span>
                </span>
              ) : (
                <RatioToggle
                  active={size}
                  onSelect={onSizeChange}
                  item={item}
                />
              )}

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Settings button */}
              <button
                tabIndex={-1}
                onClick={handleFlipToBack}
                title="/settings"
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
              >
                <Settings className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>

            {/* Content */}
            <div className={cn(
              'flex-1 bg-black flex min-h-0',
              isText ? 'items-stretch' : 'items-center justify-center',
              !isText && (size === 'portrait' || size === 'square') && 'py-2',
            )}>
              {isText ? (
                <ImageViewer item={item} size={size} />
              ) : size === 'portrait' ? (
                <div className="aspect-[9/16] h-full max-w-full">
                  {isClip
                    ? <ClipContent item={item} size={size} onRender={onRender} />
                    : <ImageViewer item={item} size={size} />}
                </div>
              ) : size === 'square' ? (
                <div className="aspect-square h-full max-w-full">
                  {isClip
                    ? <ClipContent item={item} size={size} onRender={onRender} />
                    : <ImageViewer item={item} size={size} />}
                </div>
              ) : (
                isClip
                  ? <ClipContent item={item} size={size} onRender={onRender} />
                  : <ImageViewer item={item} size={size} />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            {/* Top bar — matches front */}
            <div className="shrink-0 px-3 py-3 flex items-center justify-between relative bg-black/60 border-b border-zinc-800/60">
              <div className="flex gap-1">
                <button
                  tabIndex={-1}
                  onClick={() => setBackTab('settings')}
                  className={cn(
                    'h-8 px-3 flex items-center font-mono text-[13px] font-bold transition-all duration-[120ms] relative',
                    backTab === 'settings' ? 'text-cyan-400' : 'text-muted-foreground hover:text-white/70',
                  )}
                  style={{ background: backTab === 'settings' ? 'rgba(0,217,255,0.06)' : 'transparent' }}
                >
                  <span>/settings</span>
                  {backTab === 'settings' && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />}
                </button>
                <button
                  tabIndex={-1}
                  onClick={() => setBackTab('files')}
                  className={cn(
                    'h-8 px-3 flex items-center font-mono text-[13px] font-bold transition-all duration-[120ms] relative',
                    backTab === 'files' ? 'text-cyan-400' : 'text-muted-foreground hover:text-white/70',
                  )}
                  style={{ background: backTab === 'files' ? 'rgba(0,217,255,0.06)' : 'transparent' }}
                >
                  <span>/files</span>
                  {backTab === 'files' && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />}
                </button>
                <button
                  tabIndex={-1}
                  onClick={() => setBackTab('history')}
                  className={cn(
                    'h-8 px-3 flex items-center font-mono text-[13px] font-bold transition-all duration-[120ms] relative',
                    backTab === 'history' ? 'text-cyan-400' : 'text-muted-foreground hover:text-white/70',
                  )}
                  style={{ background: backTab === 'history' ? 'rgba(0,217,255,0.06)' : 'transparent' }}
                >
                  <span>/history</span>
                  {backTab === 'history' && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />}
                </button>
              </div>

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              <div
                className="w-6 h-6 flex items-center justify-center text-muted-foreground cursor-pointer"
                onClick={() => onFlippedChange(false)}
              >
                <RotateCcw className="w-4 h-4 stroke-[2.5]" />
              </div>
            </div>

            {/* Back face body */}
            {backTab === 'settings' ? (
              <div className="flex-1 overflow-auto bg-black">
                <SettingsPane
                  item={item}
                  renderOrientation={renderOrientation}
                  onSizeChange={onSizeChange}
                  onRender={onRender}
                  settings={settings}
                  onSettingsChange={onSettingsChange}
                />
              </div>
            ) : backTab === 'files' ? (
              <div className="flex-1 flex min-h-0">
                <div
                  data-tabstop="files"
                  tabIndex={0}
                  onKeyDown={handleFileKeyDown}
                  className="w-[212px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40 outline-none focus:ring-1 focus:ring-primary/40"
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
            ) : commits.length === 0 ? (
              <div className="flex-1 bg-black">
                <HistoryEmptyState loading={historyLoading} />
              </div>
            ) : (
              <div className="flex-1 flex min-h-0">
                <div className="w-[280px] shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40 pr-1 pt-1">
                  <HistoryListPane
                    commits={commits}
                    selectedHash={selectedCommitHash}
                    onSelectCommit={setSelectedCommitHash}
                    onRefresh={() => fetchHistory(item.id, projectSlug)}
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
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AssetViewShell({ fillParent, children }: { fillParent: boolean; children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'bg-black border-2 border-border/50 relative shadow-lg group',
          fillParent ? 'w-full h-full' : 'w-full max-w-4xl aspect-video'
        )}
      >
        <div className="w-full h-full flex items-center justify-center bg-zinc-900 relative overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}

export function IdleScreen({
  label,
  badge,
  fillParent = false,
}: {
  label: string;
  badge?: string;
  fillParent?: boolean;
}) {
  return (
    <AssetViewShell fillParent={fillParent}>
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-full border border-primary/30 flex items-center justify-center mx-auto animate-pulse">
          <div className="w-12 h-12 rounded-full bg-primary/10" />
        </div>
        <p className="font-mono text-primary/50 text-sm">{label}</p>
      </div>
      {badge && (
        <div className="absolute top-4 left-4 font-mono text-sm text-primary/80 bg-black/50 px-2 py-1 border border-primary/20">
          {badge}
        </div>
      )}
    </AssetViewShell>
  );
}

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Info, ChevronDown, RotateCcw, AudioLines, FileText, Monitor, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { MediaItem } from '@/components/sidebar/types';

export type ViewerSize = 'landscape' | 'portrait' | 'original';

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
    const cropFile = size === 'landscape' ? 'image_1920x1080.jpg' : 'image_1080x1920.jpg';
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
    return (
      <div className="flex items-center justify-center w-full h-full p-6">
        {item.prompt ? (
          <p className="text-sm leading-relaxed text-primary/50 whitespace-pre-wrap line-clamp-[12] max-w-lg">{item.prompt}</p>
        ) : (
          <FileText className="w-16 h-16 text-primary/20" />
        )}
      </div>
    );
  }

  return null;
}

function ClipViewer({ item }: { item: MediaItem }) {
  if (!item.filePath) return null;
  const thumbSrc = item.thumbnailSrc || item.filePath.replace(/\/[^/]+$/, '/thumbnail.jpg');
  return (
    <video
      key={item.id}
      src={item.filePath}
      poster={thumbSrc}
      controls
      tabIndex={-1}
      className="w-full h-full object-contain"
      draggable={false}
    />
  );
}

function ratioLabel(size: ViewerSize, item: MediaItem): string {
  switch (size) {
    case 'original':
      return item.width && item.height ? `/original ${item.width}x${item.height}` : '/original';
    case 'landscape':
      return '/landscape 1920x1080';
    case 'portrait':
      return '/portrait 1080x1920';
  }
}

const ratioIcons: Record<ViewerSize, typeof Monitor> = {
  original: Monitor,
  landscape: Monitor,
  portrait: Smartphone,
};

function RatioToggle({ active, onSelect, item }: { active: ViewerSize; onSelect: (s: ViewerSize) => void; item: MediaItem }) {
  const sizes: ViewerSize[] = ['original', 'landscape', 'portrait'];
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
          return (
            <DropdownMenuItem key={size} onClick={() => onSelect(size)} className="py-2.5">
              <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">{'\u203A'}</span>
              <span className="font-mono font-bold text-xs tracking-wider leading-none flex-1">{ratioLabel(size, item)}</span>
              <span className="ml-2 opacity-80 flex items-center"><Icon className="h-3 w-3" /></span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const clipRatioItems: Array<{ icon: typeof Monitor; label: string; value: ViewerSize }> = [
  { icon: Monitor, label: '16:9', value: 'landscape' },
  { icon: Smartphone, label: '9:16', value: 'portrait' },
];

function ClipRatioToggle({ active, onSelect }: { active: ViewerSize; onSelect: (s: ViewerSize) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-sm bg-black/60 p-0.5">
      {clipRatioItems.map(({ icon: Icon, label, value }) => (
        <button
          key={value}
          tabIndex={-1}
          onClick={() => onSelect(value)}
          className={cn(
            'px-2 py-1 text-[10px] font-mono font-bold tracking-wider rounded-sm transition-all duration-150 flex items-center gap-1',
            value === active
              ? 'bg-primary/20 text-primary shadow-[0_0_8px_rgba(0,255,255,0.25)]'
              : 'text-white/40 hover:text-white/70 hover:bg-white/5',
          )}
        >
          <Icon className="w-3 h-3" />{label}
        </button>
      ))}
    </div>
  );
}

function JsonNode({ data, indent = 0 }: { data: unknown; indent?: number }) {
  const pad = '  '.repeat(indent);
  const bracketClass = 'text-primary/30';
  const punctClass = 'text-zinc-600';

  if (data === null) return <span style={{ color: '#ff4060' }}>null</span>;
  if (typeof data === 'boolean') return <span style={{ color: '#ffcc00' }}>{String(data)}</span>;
  if (typeof data === 'number') return <span style={{ color: '#ff00ff' }}>{data}</span>;
  if (typeof data === 'string') return <span style={{ color: '#39ff14' }}>"{data}"</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className={bracketClass}>[]</span>;
    return (
      <>
        <span className={bracketClass}>[</span>{'\n'}
        {data.map((val, i) => (
          <span key={i}>
            {pad}  <JsonNode data={val} indent={indent + 1} />
            {i < data.length - 1 && <span className={punctClass}>,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className={bracketClass}>]</span>
      </>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className={bracketClass}>{'{}'}</span>;
    return (
      <>
        <span className={bracketClass}>{'{'}</span>{'\n'}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {pad}  <span style={{ color: '#00e5ff' }}>"{key}"</span>
            <span className={punctClass}>: </span>
            <JsonNode data={val} indent={indent + 1} />
            {i < entries.length - 1 && <span className={punctClass}>,</span>}
            {'\n'}
          </span>
        ))}
        {pad}<span className={bracketClass}>{'}'}</span>
      </>
    );
  }

  return <span>{String(data)}</span>;
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

type ManifestFile = { name: string; size_bytes: number; extension: string | null };

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

function FileListPane({ files, selectedFile, onSelectFile, loading }: {
  files: ManifestFile[];
  selectedFile: string;
  onSelectFile: (name: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }
  return (
    <div className="py-1">
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

function FileContentPane({ content, loading, fileName, fileUrl }: {
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

export function AssetViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
}) {
  const isClip = item.type === 'video' || item.type === 'final';
  const [manifest, setManifest] = useState<ManifestFile[] | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState('.original.json');
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

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

  useEffect(() => {
    onFlippedChange(false);
    setManifest(null);
    setSelectedFile('.original.json');
    setFileContent(null);
  }, [item.id, onFlippedChange]);

  const handleFlipToBack = () => {
    onFlippedChange(true);
    if (manifest === null) {
      fetchManifest();
      fetchFileContent('.original.json');
    }
  };

  const handleSelectFile = (fileName: string) => {
    setSelectedFile(fileName);
    setFileContent(null);
    fetchFileContent(fileName);
  };

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
          size === 'original' ? 'w-full h-full'
            : size === 'landscape' ? 'aspect-video w-full h-full'
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
            <div className="shrink-0 px-3 py-2.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
              {isClip
                ? <ClipRatioToggle active={size} onSelect={onSizeChange} />
                : <RatioToggle active={size} onSelect={onSizeChange} item={item} />}

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Info button */}
              <button
                tabIndex={-1}
                onClick={handleFlipToBack}
                title="/info"
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
              >
                <Info className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>

            {/* Content */}
            <div className={cn(
              'flex-1 bg-black flex items-center justify-center min-h-0',
              size === 'portrait' && 'py-2',
            )}>
              {size === 'portrait' ? (
                <div className="aspect-[9/16] h-full max-w-full">
                  {isClip
                    ? <ClipViewer item={item} />
                    : <ImageViewer item={item} size={size} />}
                </div>
              ) : (
                isClip
                  ? <ClipViewer item={item} />
                  : <ImageViewer item={item} size={size} />
              )}
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            {/* Top bar — matches front */}
            <div className="shrink-0 px-3 py-2.5 bg-black/60 border-b border-zinc-800/60 flex items-center justify-between relative">
              <span className="text-xs font-mono font-bold text-muted-foreground">Files</span>

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Flip back */}
              <button
                tabIndex={-1}
                onClick={() => onFlippedChange(false)}
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
              >
                <RotateCcw className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>

            {/* Two-pane body */}
            <div className="flex-1 flex min-h-0">
              <div
                data-tabstop="files"
                tabIndex={0}
                onKeyDown={handleFileKeyDown}
                className="w-48 shrink-0 border-r border-zinc-800/60 overflow-y-auto bg-black/40 outline-none focus:ring-1 focus:ring-primary/40"
              >
                <FileListPane
                  files={manifest ?? []}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
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

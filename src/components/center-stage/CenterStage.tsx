import { useState, useEffect, useCallback } from 'react';
import { X, Info, ChevronDown, RotateCcw, AudioLines, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import type { MediaItem } from '@/components/sidebar/types';

type ViewerSize = 'landscape' | 'portrait';

function ImageViewer({ item }: { item: MediaItem }) {
  const type = item.type;
  const thumbSrc = item.thumbnailSrc || (item.filePath ? item.filePath.replace(/\/[^/]+$/, '/thumbnail.jpg') : null);

  if (type === 'image') {
    return item.filePath ? (
      <img src={item.filePath} alt={item.title} className="w-full h-full object-contain" draggable={false} />
    ) : null;
  }

  if (type === 'video' || type === 'final') {
    return thumbSrc ? (
      <img src={thumbSrc} alt={item.title} className="w-full h-full object-contain" draggable={false} />
    ) : null;
  }

  if (type === 'audio') {
    return (
      <div className="flex items-center justify-center w-full h-full">
        <AudioLines className="w-16 h-16 text-primary/30" />
      </div>
    );
  }

  if (type === 'script' || type === 'plan') {
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

function JsonNode({ data, indent = 0 }: { data: unknown; indent?: number }) {
  const pad = '  '.repeat(indent);
  const bracketClass = 'text-primary/30';
  const punctClass = 'text-zinc-600';

  if (data === null) return <span style={{ color: '#ff4060' }}>null</span>;
  if (typeof data === 'boolean') return <span className="text-accent">{String(data)}</span>;
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
            {pad}  <span className="text-primary">"{key}"</span>
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
    return <p className="text-sm text-primary/50 font-mono animate-pulse">Loading metadata...</p>;
  }
  if (data === null) {
    return <p className="text-sm text-muted-foreground font-mono">No metadata available.</p>;
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

export function AssetViewer({ item, projectSlug, onClose }: {
  item: MediaItem;
  projectSlug: string;
  onClose: () => void;
}) {
  const [size, setSize] = useState<ViewerSize>('landscape');
  const [flipped, setFlipped] = useState(false);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);

  const fetchMetadata = useCallback(async () => {
    setMetaLoading(true);
    try {
      const res = await fetch(`/files/${projectSlug}/${item.id}/.original.json`);
      if (res.ok) {
        const json = await res.json();
        setMetadata(JSON.stringify(json, null, 2));
      } else {
        setMetadata(`Error: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      setMetadata(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMetaLoading(false);
    }
  }, [projectSlug, item.id]);

  // Reset flip and metadata when item changes
  useEffect(() => {
    setFlipped(false);
    setMetadata(null);
  }, [item.id]);

  const handleFlipToBack = () => {
    setFlipped(true);
    if (metadata === null) fetchMetadata();
  };

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'flip-card-perspective',
          size === 'landscape' ? 'aspect-video w-full h-full' : 'aspect-[9/16] h-full',
        )}
      >
        <div className={cn('flip-card-inner w-full h-full relative', flipped && 'flipped')}>
          {/* FRONT FACE */}
          <div className="flip-card-face absolute inset-0 flex flex-col rounded-xl overflow-hidden border border-border/50">
            {/* Solid top bar */}
            <div className="relative flex items-center justify-between px-3 py-2 bg-black/60 border-b border-zinc-800/60">
              {/* Left: Size dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono text-white/80 hover:bg-white/10 transition-colors">
                    {size === 'landscape' ? 'Landscape' : 'Portrait'}
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setSize('landscape')}>Landscape</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSize('portrait')}>Portrait</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Center: slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs font-mono text-primary/80 truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Right: Info + Close */}
              <div className="flex items-center gap-1">
                <button
                  onClick={handleFlipToBack}
                  className="p-1.5 rounded hover:bg-white/10 transition-colors"
                >
                  <Info className="w-4 h-4 text-white/80" />
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4 text-white/80" />
                </button>
              </div>
            </div>

            {/* Content area */}
            <div className="flex-1 bg-black">
              <ImageViewer item={item} />
            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col rounded-xl overflow-hidden border border-border/50">
            {/* Solid top bar */}
            <div className="relative flex items-center justify-between px-3 py-2 bg-black/60 border-b border-zinc-800/60">
              {/* Left: METADATA label */}
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-primary">METADATA</span>

              {/* Center: slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-xs font-mono text-primary/80 truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Right: Flip back + Close */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setFlipped(false)}
                  className="p-1.5 rounded hover:bg-white/10 transition-colors"
                >
                  <RotateCcw className="w-4 h-4 text-white/80" />
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4 text-white/80" />
                </button>
              </div>
            </div>

            {/* Terminal area */}
            <div className="flex-1 relative overflow-auto p-4" style={{ backgroundColor: 'hsl(220, 20%, 5%)' }}>
              {/* Scanlines overlay */}
              <div className="terminal-scanlines absolute inset-0 pointer-events-none" />
              {/* Vignette overlay */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.6) 100%)' }}
              />
              <div className="relative z-10">
                <JsonTerminal data={metadata} loading={metaLoading} />
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

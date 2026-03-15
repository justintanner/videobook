import { useState, useEffect, useCallback, useRef } from 'react';
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
      className="w-full h-full object-contain"
      draggable={false}
    />
  );
}

const ratioLabels: Record<ViewerSize, string> = {
  original: '/original',
  landscape: '/landscape',
  portrait: '/portrait',
};

function RatioToggle({ active, onSelect }: { active: ViewerSize; onSelect: (s: ViewerSize) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold text-primary/70 hover:text-primary hover:bg-primary/10 transition-colors">
          {ratioLabels[active]}
          <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => onSelect('original')}>/original</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSelect('landscape')}>/landscape</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSelect('portrait')}>/portrait</DropdownMenuItem>
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

export function AssetViewer({ item, projectSlug, size, onSizeChange, flipped, onFlippedChange }: {
  item: MediaItem;
  projectSlug: string;
  size: ViewerSize;
  onSizeChange: (s: ViewerSize) => void;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
}) {
  const isClip = item.type === 'video' || item.type === 'final';
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

  useEffect(() => {
    onFlippedChange(false);
    setMetadata(null);
  }, [item.id, onFlippedChange]);

  const handleFlipToBack = () => {
    onFlippedChange(true);
    if (metadata === null) fetchMetadata();
  };

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
                : <RatioToggle active={size} onSelect={onSizeChange} />}

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Info button */}
              <button
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
              <span className="text-xs font-mono font-bold text-muted-foreground">Metadata</span>

              {/* Center slug */}
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="font-mono text-xs font-bold text-muted-foreground truncate max-w-[50%]">{item.slug}</span>
              </span>

              {/* Flip back */}
              <button
                onClick={() => onFlippedChange(false)}
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
              >
                <RotateCcw className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 bg-black overflow-auto p-4">
              <JsonTerminal data={metadata} loading={metaLoading} />
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

import { useState, useEffect, useCallback } from 'react';
import { X, Info, ChevronDown, AudioLines, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MediaItem } from '@/components/sidebar/types';

type ViewerSize = 'landscape' | 'portrait';

function AssetContent({ item }: { item: MediaItem }) {
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

export function AssetViewer({ item, projectSlug, onClose }: {
  item: MediaItem;
  projectSlug: string;
  onClose: () => void;
}) {
  const [size, setSize] = useState<ViewerSize>('landscape');
  const [infoOpen, setInfoOpen] = useState(false);
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
    if (infoOpen && metadata === null) fetchMetadata();
  }, [infoOpen, metadata, fetchMetadata]);

  // Reset metadata when item changes
  useEffect(() => {
    setMetadata(null);
  }, [item.id]);

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div
        className={cn(
          'relative bg-card/30 backdrop-blur-sm clip-corner-br border border-border/50 shadow-lg overflow-hidden',
          size === 'landscape' ? 'aspect-video w-full h-full' : 'aspect-[9/16] h-full',
        )}
      >
        {/* Content */}
        <div className="w-full h-full bg-zinc-900">
          <AssetContent item={item} />
        </div>

        {/* Top bar overlay */}
        <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/60 to-transparent">
          {/* Info button */}
          <button
            onClick={() => setInfoOpen(true)}
            className="p-1.5 rounded hover:bg-white/10 transition-colors"
          >
            <Info className="w-4 h-4 text-white/80" />
          </button>

          {/* Size dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono text-white/80 hover:bg-white/10 transition-colors">
                {size === 'landscape' ? 'Landscape' : 'Portrait'}
                <ChevronDown className="w-3 h-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem onClick={() => setSize('landscape')}>Landscape</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSize('portrait')}>Portrait</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Close */}
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4 text-white/80" />
          </button>
        </div>

        {/* Bottom bar overlay — slug badge */}
        <div className="absolute bottom-0 inset-x-0 z-10 flex items-center justify-center px-3 py-2 bg-gradient-to-t from-black/60 to-transparent">
          <span
            className="px-2 py-1 rounded text-xs font-mono font-bold bg-black/85 backdrop-blur-md border text-primary"
            style={{ borderColor: 'rgba(0, 255, 255, 0.2)' }}
          >
            {item.slug}
          </span>
        </div>

        {/* Clipped corner border (matches CardShell) */}
        <svg
          className="absolute pointer-events-none z-40 opacity-100"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          style={{ bottom: '-5px', right: '-2px' }}
        >
          <line x1="0" y1="14" x2="14" y2="0" stroke="var(--color-primary)" strokeWidth="2" />
        </svg>
      </div>

      {/* Info modal */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-primary">{item.slug} metadata</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            {metaLoading ? (
              <p className="text-sm text-muted-foreground font-mono">Loading...</p>
            ) : (
              <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">{metadata}</pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
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

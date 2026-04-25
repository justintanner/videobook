import { AudioLines, Compass, FileText, Film, ImageIcon, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import type { MediaItem, ClipState } from './types';

interface SidebarMicroThumbProps {
  item: MediaItem;
  selected?: boolean;
  onClick?: () => void;
}

function getStatusDot(status: ClipState | undefined): string | null {
  if (!status) return null;
  switch (status) {
    case 'uploading':
    case 'rendering':
    case 'rendering-landscape':
    case 'rendering-portrait':
    case 'rendering-square':
    case 'render-queued':
    case 'render-queued-landscape':
    case 'render-queued-portrait':
    case 'render-queued-square':
    case 'transcribing':
    case 'loading':
      return 'bg-primary animate-pulse';
    case 'generating':
    case 'downloading':
      return 'bg-green-500 animate-pulse';
    case 'error':
      return 'bg-red-500';
    case 'corrupt':
      return 'bg-pink-500';
    case 'untranscribed':
      return 'bg-primary/50';
    default:
      return null;
  }
}

function ThumbIcon({ type }: { type: MediaItem['type'] }) {
  switch (type) {
    case 'audio':
      return <AudioLines className="w-3.5 h-3.5 text-primary/50" />;
    case 'script':
      return <FileText className="w-3.5 h-3.5 text-primary/50" />;
    case 'plan':
      return <Compass className="w-3.5 h-3.5 text-indigo-400/50" />;
    case 'video':
      return <Film className="w-3.5 h-3.5 text-primary/50" />;
    case 'image':
      return <ImageIcon className="w-3.5 h-3.5 text-primary/50" />;
    case 'character':
      return <User className="w-3.5 h-3.5 text-violet-400/60" />;
    case 'final':
      return <Film className="w-3.5 h-3.5 text-amber-400/50" />;
  }
}

export function SidebarMicroThumb({ item, selected, onClick }: SidebarMicroThumbProps) {
  const src = item.thumbnailSrc ?? (item.filePath || null);
  const hasImage = !!src && (item.type === 'image' || item.type === 'character' || item.type === 'video' || item.type === 'final');
  const dot = getStatusDot(item.status);
  const isGold = item.type === 'final';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
            'relative w-6 h-6 rounded-sm overflow-hidden shrink-0 transition-all border border-border/40',
            'hover:ring-1 hover:ring-primary/50',
            selected && !isGold && 'ring-1 ring-primary',
            selected && isGold && 'ring-1 ring-amber-400/60',
            item.type === 'plan' ? 'bg-[#151b3d]' : 'bg-card/80',
          )}
        >
          {hasImage ? (
            <img
              src={src}
              alt={item.slug}
              loading="lazy"
              draggable={false}
              className="w-full h-full object-cover"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <span className="flex items-center justify-center w-full h-full">
              <ThumbIcon type={item.type} />
            </span>
          )}
          {dot && (
            <span className={cn('absolute bottom-0 right-0 w-[5px] h-[5px] rounded-full', dot)} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">{item.slug}</TooltipContent>
    </Tooltip>
  );
}

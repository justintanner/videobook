import { useState } from 'react';
import { AudioLines, Compass, FileText, Film, ImageIcon, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import type { MediaItem } from './types';
import { getCardVisualState } from './stateColors';

interface SidebarMicroThumbProps {
  item: MediaItem;
  selected?: boolean;
  onClick?: () => void;
}

function ThumbIcon({ type }: { type: MediaItem['type'] }) {
  switch (type) {
    case 'audio':
 return <AudioLines className="size-3.5 text-primary/50" />;
    case 'script':
 return <FileText className="size-3.5 text-primary/50" />;
    case 'notebook':
 return <Compass className="size-3.5 text-emerald-400/50" />;
    case 'video':
 return <Film className="size-3.5 text-primary/50" />;
    case 'image':
 return <ImageIcon className="size-3.5 text-primary/50" />;
    case 'character':
 return <User className="size-3.5 text-violet-400/60" />;
    case 'final':
 return <Film className="size-3.5 text-amber-400/50" />;
  }
}

export function SidebarMicroThumb({ item, selected, onClick }: SidebarMicroThumbProps) {
  const src = item.thumbnailSrc ?? (item.filePath || null);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const hasImage = !!src && erroredSrc !== src && (item.type === 'image' || item.type === 'character' || item.type === 'video' || item.type === 'final');
  const dot = getCardVisualState(item).dot;
  const isGold = item.type === 'final';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={cn(
 'relative size-6 rounded-sm overflow-hidden shrink-0 transition-all border border-border/40',
            'hover:ring-1 hover:ring-primary/50',
            selected && !isGold && 'ring-1 ring-primary',
            selected && isGold && 'ring-1 ring-amber-400/60',
            'bg-card/80',
          )}
        >
          {hasImage ? (
            <img
              src={src}
              alt={item.slug}
              loading="lazy"
              draggable={false}
 className="size-full object-cover"
              onError={() => setErroredSrc(src)}
            />
          ) : (
 <span className="flex items-center justify-center size-full ">
              <ThumbIcon type={item.type} />
            </span>
          )}
          {dot && (
 <span className={cn('absolute bottom-0 right-0 size-[5px] rounded-full', dot)} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">{item.slug}</TooltipContent>
    </Tooltip>
  );
}

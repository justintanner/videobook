import { AudioLines } from 'lucide-react';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge } from './badges';

import type { ReactNode } from 'react';

interface AudioCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
}

export function AudioCard({ item, contextMenuContent, selected, onClick }: AudioCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = status === 'corrupt';

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick}>
      {/* CONTENT - Audio icon */}
      <div className="w-full h-full relative overflow-hidden">
        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
        {/* Scanlines overlay */}
        <div className="absolute inset-0 scanlines pointer-events-none" />
        {/* Vignette effect */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.6)_100%)]" />
        {/* Centered audio icon */}
        <div className="absolute inset-0 flex items-center justify-center">
          <AudioLines className="w-10 h-10 text-primary/30" />
        </div>
      </div>

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge slug={item.slug} colorScheme="cyan" isError={isError} />}
    </CardShell>
  );
}

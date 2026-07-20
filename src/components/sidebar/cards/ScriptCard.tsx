import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge } from './badges';
import { ErrorCardActions } from './ErrorCardActions';

import type { ReactNode } from 'react';

interface ScriptCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onRecover?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}

export function ScriptCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onRecover, onDelete }: ScriptCardProps) {
  const isCorrupt = false;
  const isError = (item.status ?? 'ready') === 'error';
  const scriptText = item.prompt;

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen}>
      {/* CONTENT - Script */}
 <div className="size-full relative overflow-hidden">
        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
        {/* Scanlines overlay */}
        <div className="absolute inset-0 scanlines pointer-events-none" />
        {/* Vignette effect */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.6)_100%)]" />
        <div className="absolute inset-0 p-2 overflow-hidden">
          <p className="text-[10px] leading-tight text-primary/40 line-clamp-[8] whitespace-pre-wrap">{scriptText}</p>
        </div>
      </div>

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} />}

      {/* Recover / Delete buttons — visible on hover for error-state cards */}
      {isError && <ErrorCardActions item={item} onRecover={onRecover} onDelete={onDelete} />}
    </CardShell>
  );
}

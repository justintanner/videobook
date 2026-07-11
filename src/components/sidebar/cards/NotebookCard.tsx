import { Compass } from 'lucide-react';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge } from './badges';

import type { ReactNode } from 'react';

interface NotebookCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
}

export function NotebookCard({ item, contextMenuContent, selected, onClick, onMarkSeen }: NotebookCardProps) {
  const isCorrupt = false;
  const notebookText = item.prompt;

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen}>
      {/* CONTENT - Blueprint aesthetic, emerald-toned */}
      <div className="w-full h-full relative overflow-hidden">
        {/* Emerald-to-near-black gradient background */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a1f15] via-[#13302a] to-[#1c4438]" />
        {/* Blueprint grid overlay (12px grid) */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(52,211,153,0.15) 1px, transparent 1px), linear-gradient(to bottom, rgba(52,211,153,0.15) 1px, transparent 1px)',
            backgroundSize: '12px 12px',
          }}
        />
        {/* Emerald-tinted vignette */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(10,31,21,0.7)_100%)]" />
        {/* Content: text preview or centered icon */}
        {notebookText ? (
          <div className="absolute inset-0 p-2 overflow-hidden">
            <p className="text-[10px] leading-tight text-emerald-300/40 line-clamp-[8] whitespace-pre-wrap">
              {notebookText}
            </p>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Compass className="w-10 h-10 text-emerald-400/30" />
          </div>
        )}
      </div>

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} />}
    </CardShell>
  );
}

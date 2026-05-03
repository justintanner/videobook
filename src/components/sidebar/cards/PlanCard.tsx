import { Compass } from 'lucide-react';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge } from './badges';

import type { ReactNode } from 'react';

interface PlanCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
}

export function PlanCard({ item, contextMenuContent, selected, onClick, onMarkSeen }: PlanCardProps) {
  const isCorrupt = false;
  const planText = item.prompt;

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen}>
      {/* CONTENT - Blueprint aesthetic */}
      <div className="w-full h-full relative overflow-hidden">
        {/* Indigo-to-navy gradient background */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0e2a] via-[#151b3d] to-[#1e2650]" />
        {/* Blueprint grid overlay (12px grid) */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(129,140,248,0.15) 1px, transparent 1px), linear-gradient(to bottom, rgba(129,140,248,0.15) 1px, transparent 1px)',
            backgroundSize: '12px 12px',
          }}
        />
        {/* Indigo-tinted vignette */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(10,14,42,0.7)_100%)]" />
        {/* Content: text preview or centered icon */}
        {planText ? (
          <div className="absolute inset-0 p-2 overflow-hidden">
            <p className="text-[10px] leading-tight text-indigo-300/40 line-clamp-[8] whitespace-pre-wrap">
              {planText}
            </p>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Compass className="w-10 h-10 text-indigo-400/30" />
          </div>
        )}
      </div>

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} />}
    </CardShell>
  );
}

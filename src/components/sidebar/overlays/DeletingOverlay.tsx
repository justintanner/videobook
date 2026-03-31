import { Trash2 } from 'lucide-react';
import type { OverlayProps } from './types';

export function DeletingOverlay({ item }: OverlayProps) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/60 overflow-hidden">
      {/* Scanline overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(239, 68, 68, 0.05) 2px, rgba(239, 68, 68, 0.05) 4px)'
        }}
      />

      {/* Corner brackets */}
      <div className="absolute top-2 left-2 w-3 h-3 border-l-2 border-t-2 border-red-500/50" />
      <div className="absolute top-2 right-2 w-3 h-3 border-r-2 border-t-2 border-red-500/50" />
      <div className="absolute bottom-2 left-2 w-3 h-3 border-l-2 border-b-2 border-red-500/50" />
      <div className="absolute bottom-2 right-2 w-3 h-3 border-r-2 border-b-2 border-red-500/50" />

      {/* Center content */}
      <div className="relative flex flex-col items-center z-10">
        <Trash2 className="w-7 h-7 text-red-500 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
        <div className="mt-2 text-xs font-mono font-bold tracking-[0.15em] text-red-500">DELETING</div>
      </div>

      {/* Slug at bottom */}
      <div className="absolute bottom-3 left-2 right-2 text-center">
        <span className="text-[9px] font-mono text-red-500/50 tracking-wide">{item.slug}</span>
      </div>
    </div>
  );
}

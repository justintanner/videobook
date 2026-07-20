import { Trash2 } from 'lucide-react';
import type { OverlayProps } from './types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';

export function DeletingOverlay({ item }: OverlayProps) {
  const visual = getCardVisualState(item);
  const colorRgba = (alpha: number) => colorWithAlpha(visual, alpha);

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/60 overflow-hidden">
      {/* Scanline overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          background: `repeating-linear-gradient(0deg, transparent, transparent 2px, ${colorRgba(0.05)} 2px, ${colorRgba(0.05)} 4px)`
        }}
      />

      {/* Center content */}
      <div className="relative flex flex-col items-center z-10">
 <Trash2 className="size-7" style={{ color: visual.color, filter:`drop-shadow(0 0 10px ${visual.glow})` }} />
        <div className="mt-2 text-xs font-mono font-bold tracking-[0.15em]" style={{ color: visual.color }}>DELETING</div>
      </div>
    </div>
  );
}

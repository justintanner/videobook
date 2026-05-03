import { AlertTriangle } from 'lucide-react';
import type { OverlayProps } from './types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function CorruptOverlay({ item: _item }: OverlayProps) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 overflow-hidden">
      {/* Scanline overlay */}
      <div className="absolute inset-0 pointer-events-none corrupt-scanlines opacity-60" />

      {/* Pixel grid background */}
      <div className="absolute inset-0 pointer-events-none corrupt-pixel-grid opacity-30" />

      {/* Static noise - garbled characters (static, not animated) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
        <div className="w-full h-full flex flex-wrap justify-center items-center text-[6px] font-mono text-pink-500/60 leading-none">
          {[...Array(120)].map((_, i) => (
            <span key={i} className="inline-block w-2">
              {String.fromCharCode(0x2588 + (i % 8))}
            </span>
          ))}
        </div>
      </div>

      {/* Horizontal glitch bars */}
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="absolute left-0 right-0 h-2 bg-pink-500/20 corrupt-glitch-bar pointer-events-none"
          style={{
            top: `${20 + i * 20}%`,
            animationDelay: `${i * 0.4}s`,
            animationDuration: `${1.2 + i * 0.3}s`,
          }}
        />
      ))}

      {/* Screen tear displaced section */}
      <div className="absolute inset-0 pointer-events-none corrupt-screen-tear">
        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 via-transparent to-pink-500/10" />
      </div>

      {/* Center content */}
      <div className="relative flex flex-col items-center z-10">
        {/* Alert icon with RGB split effect */}
        <div className="relative">
          {/* Red ghost (left) */}
          <AlertTriangle className="absolute w-8 h-8 text-red-500/50" style={{ transform: 'translateX(-3px)' }} />
          {/* Cyan ghost (right) */}
          <AlertTriangle className="absolute w-8 h-8 text-cyan-500/50" style={{ transform: 'translateX(3px)' }} />
          {/* Main icon */}
          <AlertTriangle className="relative w-8 h-8 text-pink-500 drop-shadow-[0_0_10px_#ff0080]" />
        </div>

        {/* CORRUPT label */}
        <div className="mt-2 text-sm font-mono font-bold tracking-[0.2em] text-pink-500">CORRUPT</div>
      </div>

      {/* Vignette with color aberration */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(255,0,128,0.15)_70%,rgba(0,0,0,0.8)_100%)]" />
    </div>
  );
}

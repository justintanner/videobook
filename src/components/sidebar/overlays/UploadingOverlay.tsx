import { Film, FileText, Image as ImageIcon } from 'lucide-react';
import type { OverlayProps } from './types';

export function UploadingOverlay({ item }: OverlayProps) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 overflow-hidden">
      {/* Scanline overlay - cyan tint */}
      <div className="absolute inset-0 pointer-events-none scanlines opacity-50" />

      {/* Pixel grid background */}
      <div className="absolute inset-0 pointer-events-none uploading-pixel-grid opacity-20" />

      {/* Matrix-style rising data columns (upward flow) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="absolute bottom-0 text-[8px] font-mono text-cyan-500/40 whitespace-nowrap"
            style={{
              left: `${15 + i * 15}%`,
              animation: `uploading-data-rise ${2 + i * 0.3}s linear infinite`,
              animationDelay: `${i * 0.4}s`,
            }}
          >
            {['↑', '1', '0', 'A', 'F', '3', '7', '↑'].map((c, j) => (
              <div key={j} className="leading-tight">
                {c}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Center content */}
      <div className="relative flex flex-col items-center z-10">
        {/* Loading ring with icon */}
        <div className="relative">
          <svg className="w-10 h-10 animate-spin-slow" viewBox="0 0 64 64">
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="8 4"
              className="text-cyan-500/30"
            />
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="44 132"
              strokeLinecap="round"
              className="text-cyan-500 drop-shadow-[0_0_8px_#00ffff]"
            />
          </svg>
          {item.type === 'video' ? (
            <Film className="absolute inset-0 m-auto w-4 h-4 text-cyan-400 drop-shadow-[0_0_6px_#00ffff]" />
          ) : item.type === 'script' ? (
            <FileText className="absolute inset-0 m-auto w-4 h-4 text-cyan-400 drop-shadow-[0_0_6px_#00ffff]" />
          ) : (
            <ImageIcon className="absolute inset-0 m-auto w-4 h-4 text-cyan-400 drop-shadow-[0_0_6px_#00ffff]" />
          )}
        </div>

        {/* Retro progress bar */}
        <div className="mt-3 w-24 h-2 bg-cyan-950/50 border border-cyan-500/40 rounded-sm overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-600 to-teal-500"
            style={{
              animation: 'uploading-progress 2s ease-in-out infinite',
              boxShadow: '0 0 8px #00ffff',
            }}
          />
        </div>

        {/* Terminal text with cursor */}
        <div className="mt-2 text-[10px] font-mono text-cyan-400 tracking-wider flex items-center">
          <span className="drop-shadow-[0_0_4px_#00ffff]">UPLOADING</span>
          <span className="uploading-cursor ml-0.5">█</span>
        </div>
      </div>

      {/* Slug name at bottom */}
      <div className="absolute bottom-4 left-0 right-0 text-center">
        <span className="text-[8px] font-mono text-cyan-500/60 tracking-wider truncate max-w-[90%] inline-block px-2">
          {item.slug}
        </span>
      </div>

      {/* Glitch scanline sweep (upward) */}
      <div
        className="absolute inset-0 pointer-events-none bg-gradient-to-b from-transparent via-cyan-500/10 to-transparent h-8"
        style={{ animation: 'uploading-scanline 3s linear infinite' }}
      />
    </div>
  );
}

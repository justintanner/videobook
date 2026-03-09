import { Film, Image as ImageIcon, AudioLines, FileText, Compass } from 'lucide-react';
import type { OverlayProps } from './types';

function DownloadIcon({ type }: { type: string }) {
  const cls = 'absolute inset-0 m-auto w-4 h-4 text-violet-400 drop-shadow-[0_0_6px_#8b5cf6]';
  switch (type) {
    case 'image':
      return <ImageIcon className={cls} />;
    case 'audio':
      return <AudioLines className={cls} />;
    case 'script':
      return <FileText className={cls} />;
    case 'plan':
      return <Compass className={cls} />;
    default:
      return <Film className={cls} />;
  }
}

export function DownloadingOverlay({ item }: OverlayProps) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 overflow-hidden">
      {/* Scanline overlay - purple tint */}
      <div className="absolute inset-0 pointer-events-none downloading-scanlines opacity-50" />

      {/* Pixel grid background */}
      <div className="absolute inset-0 pointer-events-none downloading-pixel-grid opacity-20" />

      {/* Matrix-style falling data columns */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="absolute top-0 text-[8px] font-mono text-violet-500/40 whitespace-nowrap"
            style={{
              left: `${15 + i * 15}%`,
              animation: `downloading-data-fall ${2 + i * 0.3}s linear infinite`,
              animationDelay: `${i * 0.4}s`,
            }}
          >
            {['0', '1', 'F', 'A', '3', 'C', '7', 'E'].map((c, j) => (
              <div key={j} className="leading-tight">
                {c}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Center content */}
      <div className="relative flex flex-col items-center z-10">
        {/* Download icon with spinning ring */}
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
              className="text-violet-500/30"
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
              className="text-violet-500 drop-shadow-[0_0_8px_#8b5cf6]"
            />
          </svg>
          <DownloadIcon type={item.type} />
        </div>

        {/* Retro progress bar */}
        <div className="mt-3 w-24 h-2 bg-violet-950/50 border border-violet-500/40 rounded-sm overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-violet-600 to-fuchsia-500"
            style={{
              animation: 'downloading-progress 2s ease-in-out infinite',
              boxShadow: '0 0 8px #8b5cf6',
            }}
          />
        </div>

        {/* Terminal text with cursor */}
        <div className="mt-2 text-[10px] font-mono text-violet-400 tracking-wider flex items-center">
          <span className="drop-shadow-[0_0_4px_#8b5cf6]">DOWNLOADING</span>
          <span className="downloading-cursor ml-0.5">█</span>
        </div>
      </div>

      {/* URL marquee at bottom */}
      <div className="absolute bottom-4 left-0 right-0 overflow-hidden">
        <div className="downloading-marquee whitespace-nowrap text-[8px] font-mono text-violet-500/60">
          <span className="mx-4">▸</span>
          {item.slug}
          <span className="mx-4">◂</span>
        </div>
      </div>

      {/* Glitch scanline sweep */}
      <div
        className="absolute inset-0 pointer-events-none bg-gradient-to-b from-transparent via-violet-500/10 to-transparent h-8"
        style={{ animation: 'downloading-scanline 3s linear infinite' }}
      />
    </div>
  );
}

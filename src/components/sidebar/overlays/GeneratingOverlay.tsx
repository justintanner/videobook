import { ChevronRight, ChevronLeft } from 'lucide-react';
import type { OverlayProps } from './types';

const typeFallbackLabels: Record<string, string> = {
  video: 'VIDEO',
  image: 'IMAGE',
  audio: 'AUDIO',
  script: 'SCRIPT',
  plan: 'PLAN',
  final: 'VIDEO',
  character: 'CHAR',
};

interface GeneratingOverlayProps extends OverlayProps {
  /** Override the default "GENERATING <TYPE>" label (e.g. "PROCESSING", "ANALYZING", "TRIMMING"). */
  label?: string;
}

export function GeneratingOverlay({ item, label }: GeneratingOverlayProps) {
  const fallbackLabel = typeFallbackLabels[item.type] ?? 'ASSET';
  const displayLabel = label ?? `GENERATING ${fallbackLabel}`;

  const primaryColor = item.type === 'image' || item.type === 'character' ? '#3b82f6' : '#22c55e';
  const glowStyle = `0 0 8px ${primaryColor}`;

  const hexToRgb = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  };

  const hexToRgba = (hex: string, alpha: number) => {
    return `rgba(${hexToRgb(hex)}, ${alpha})`;
  };

  const colorRgba = (alpha: number) => hexToRgba(primaryColor, alpha);

  return (
    <div className="absolute inset-0 z-30 bg-black/70 overflow-hidden" style={{ '--gen-color': hexToRgb(primaryColor) } as React.CSSProperties}>
      {/* Layer 1: CRT Scanlines */}
      <div
        className="absolute inset-0 pointer-events-none opacity-50"
        style={{
          background: `repeating-linear-gradient(
            0deg,
            transparent,
            transparent 2px,
            ${colorRgba(0.05)} 2px,
            ${colorRgba(0.05)} 4px
          )`,
        }}
      />

      {/* Layer 2: Pixel Grid (8x8 chunky) */}
      <div
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(${colorRgba(0.2)} 1px, transparent 1px),
            linear-gradient(90deg, ${colorRgba(0.2)} 1px, transparent 1px)
          `,
          backgroundSize: '8px 8px',
        }}
      />

      {/* Layer 3: Diagonal Pixel Particle Streams (4 streams of 6 dots) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[0, 1, 2, 3].map((stream) => (
          <div key={stream} className="absolute inset-0">
            {[0, 1, 2, 3, 4, 5].map((dot) => (
              <div
                key={dot}
                className="absolute w-1 h-1 rounded-full"
                style={{
                  left: `${18 + stream * 20}%`,
                  bottom: `${dot * 15}%`,
                  backgroundColor: colorRgba(0.6),
                  boxShadow: `0 0 4px ${colorRgba(0.4)}`,
                  animation: `generating-particle-rise ${2.5 + stream * 0.4}s linear infinite`,
                  animationDelay: `${stream * 0.3 + dot * 0.35}s`,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Layer 4: HUD Corner Brackets */}
      <div className="absolute top-2 left-2 w-3 h-3 border-l-2 border-t-2" style={{ borderColor: colorRgba(0.7) }} />
      <div className="absolute top-2 right-2 w-3 h-3 border-r-2 border-t-2" style={{ borderColor: colorRgba(0.7) }} />
      <div className="absolute bottom-2 left-2 w-3 h-3 border-l-2 border-b-2" style={{ borderColor: colorRgba(0.7) }} />
      <div className="absolute bottom-2 right-2 w-3 h-3 border-r-2 border-b-2" style={{ borderColor: colorRgba(0.7) }} />

      {/* Layer 5: Center Content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center z-10 px-4">
        {/* Slug display */}
        <div className="max-w-full flex items-center gap-1 overflow-hidden">
          <ChevronRight className="w-2.5 h-2.5 flex-shrink-0" style={{ color: colorRgba(0.5) }} />
          <span
            className="truncate text-xs font-mono font-bold tracking-wide"
            style={{ color: primaryColor, textShadow: `0 0 8px ${primaryColor}` }}
          >
            {item.slug}
          </span>
          <ChevronLeft className="w-2.5 h-2.5 flex-shrink-0" style={{ color: colorRgba(0.5) }} />
        </div>

        {/* "GENERATING" badge */}
        <div
          className="mt-2 px-2 py-1 text-[10px] font-mono font-bold tracking-wider border flex items-center gap-1"
          style={{
            color: primaryColor,
            borderColor: colorRgba(0.6),
            backgroundColor: colorRgba(0.15),
            boxShadow: glowStyle,
            animation: 'generating-model-pulse 2s ease-in-out infinite',
            textShadow: `0 0 8px ${primaryColor}`,
          }}
        >
          <span>{displayLabel}</span>
          <span className="generating-cursor" style={{ position: 'relative', top: '-1px' }}>
            █
          </span>
        </div>

        {/* Segmented health bar (5 segments) */}
        <div className="mt-2 flex gap-0.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="w-4 h-1.5 border"
              style={{
                borderColor: colorRgba(0.4),
                animation: 'generating-segment-fill 2.5s ease-in-out infinite',
                animationDelay: `${i * 0.4}s`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Layer 6: Scanline Sweep */}
      <div
        className="absolute inset-0 pointer-events-none h-8"
        style={{
          background: `linear-gradient(to bottom, transparent, ${colorRgba(0.1)}, transparent)`,
          animation: 'overlay-scanline-sweep 3s linear infinite',
        }}
      />
    </div>
  );
}

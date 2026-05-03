import type { OverlayProps } from './types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';

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
  const visual = getCardVisualState(item);
  const glowStyle = `0 0 8px ${visual.color}`;
  const colorRgba = (alpha: number) => colorWithAlpha(visual, alpha);

  return (
    <div className="absolute inset-0 z-30 bg-black/70 overflow-hidden" style={{ '--gen-color': visual.rgb } as React.CSSProperties}>
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

      {/* Layer 3: Diagonal Pixel Particle Streams */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {[0, 1, 2].map((stream) => (
          <div key={stream} className="absolute inset-0">
            {[0, 1, 2, 3].map((dot) => (
              <div
                key={dot}
                className="absolute w-1 h-1 rounded-full"
                style={{
                  left: `${24 + stream * 24}%`,
                  bottom: `${12 + dot * 20}%`,
                  backgroundColor: colorRgba(0.6),
                  boxShadow: `0 0 4px ${colorRgba(0.4)}`,
                  animation: `generating-particle-rise ${2.8 + stream * 0.35}s linear infinite`,
                  animationDelay: `${stream * 0.35 + dot * 0.25}s`,
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Layer 4: Center Content */}
      <div className="absolute inset-x-0 top-2 bottom-9 flex items-center justify-center z-10 px-3">
        <div
          className="relative max-w-[86%] min-w-[62%] h-8 px-2.5 py-1 font-mono font-bold tracking-wider border overflow-hidden"
          style={{
            color: visual.color,
            borderColor: colorRgba(0.6),
            background: `linear-gradient(90deg, ${colorRgba(0.18)}, rgba(0,0,0,0.72), ${colorRgba(0.14)})`,
            boxShadow: glowStyle,
            animation: 'generating-model-pulse 2s ease-in-out infinite',
            textShadow: `0 0 8px ${visual.color}`,
          }}
        >
          <div
            className="absolute inset-y-0 left-0 w-1"
            style={{ backgroundColor: visual.color, boxShadow: `0 0 10px ${visual.color}` }}
          />
          <div
            className="absolute inset-y-0 right-0 w-1"
            style={{ backgroundColor: visual.color, boxShadow: `0 0 10px ${visual.color}` }}
          />
          <div className="relative flex h-full items-center justify-between gap-2">
            <span className="truncate text-[8px] leading-none">{displayLabel}</span>
            <span className="generating-cursor shrink-0 text-[10px] leading-none">█</span>
          </div>
          <div className="absolute left-2 right-2 bottom-1 flex gap-0.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-1 flex-1 border"
                style={{
                  borderColor: colorRgba(0.4),
                  animation: 'generating-segment-fill 2.5s ease-in-out infinite',
                  animationDelay: `${i * 0.28}s`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Layer 5: Scanline Sweep */}
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

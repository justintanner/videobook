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

      {/* Layer 4: Center Content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center z-10 px-4">
        <div
          className="px-2 py-1 text-[10px] font-mono font-bold tracking-wider border flex items-center gap-1"
          style={{
            color: visual.color,
            borderColor: colorRgba(0.6),
            backgroundColor: colorRgba(0.15),
            boxShadow: glowStyle,
            animation: 'generating-model-pulse 2s ease-in-out infinite',
            textShadow: `0 0 8px ${visual.color}`,
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

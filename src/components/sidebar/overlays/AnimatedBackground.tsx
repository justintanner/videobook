import type { CSSProperties } from 'react';
import type { CardVisualState } from '../stateColors';
import { colorWithAlpha } from '../stateColors';

interface AnimatedBackgroundProps {
  visual: CardVisualState;
  /** When true, particles fall (downward, e.g. downloading); otherwise rise. */
  fall?: boolean;
}

/**
 * Restores the matrix-style animated layers that lived in the per-state
 * overlays before the unified clock. Sits behind the foreground content,
 * themed by the card's visual color.
 *
 * Layers, bottom→top: scanlines, pixel grid, particle streams, sweep band.
 */
export function AnimatedBackground({ visual, fall = false }: AnimatedBackgroundProps) {
  const colorRgba = (alpha: number) => colorWithAlpha(visual, alpha);

  const cssVars = { ['--gen-color' as string]: visual.rgb } as CSSProperties;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={cssVars}>
      <div
        className="absolute inset-0 opacity-50"
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

      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(${colorRgba(0.2)} 1px, transparent 1px),
            linear-gradient(90deg, ${colorRgba(0.2)} 1px, transparent 1px)
          `,
          backgroundSize: '8px 8px',
        }}
      />

      <div className="absolute inset-0 overflow-hidden">
        {[0, 1, 2].map((stream) => (
          <div key={stream} className="absolute inset-0">
            {[0, 1, 2, 3].map((dot) => (
              <div
                key={dot}
                className="absolute w-1 h-1 rounded-full"
                style={{
                  left: `${24 + stream * 24}%`,
                  bottom: fall ? undefined : `${12 + dot * 20}%`,
                  top: fall ? `${12 + dot * 20}%` : undefined,
                  backgroundColor: colorRgba(0.6),
                  boxShadow: `0 0 4px ${colorRgba(0.4)}`,
                  animation: `generating-particle-rise ${2.8 + stream * 0.35}s linear infinite`,
                  animationDelay: `${stream * 0.35 + dot * 0.25}s`,
                  animationDirection: fall ? 'reverse' : 'normal',
                }}
              />
            ))}
          </div>
        ))}
      </div>

      <div
        className="absolute inset-0 h-8"
        style={{
          background: `linear-gradient(to bottom, transparent, ${colorRgba(0.1)}, transparent)`,
          animation: 'overlay-scanline-sweep 3s linear infinite',
        }}
      />
    </div>
  );
}

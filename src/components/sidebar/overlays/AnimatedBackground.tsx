import type { CardVisualState } from '../stateColors';
import { colorWithAlpha } from '../stateColors';

interface AnimatedBackgroundProps {
  visual: CardVisualState;
  /** When true, particles fall (downward, e.g. downloading); otherwise rise. */
  fall?: boolean;
}

const PARTICLES = [0, 1, 2, 3];

export function AnimatedBackground({ visual, fall = false }: AnimatedBackgroundProps) {
  const dotColor = colorWithAlpha(visual, 0.6);
  const dotShadow = colorWithAlpha(visual, 0.4);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {PARTICLES.map((i) => (
        <div
          key={i}
          className="absolute left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
          style={{
            bottom: fall ? undefined : `${12 + i * 20}%`,
            top: fall ? `${12 + i * 20}%` : undefined,
            backgroundColor: dotColor,
            boxShadow: `0 0 4px ${dotShadow}`,
            animation: 'generating-particle-rise 2.8s linear infinite',
            animationDelay: `${i * 0.25}s`,
            animationDirection: fall ? 'reverse' : 'normal',
          }}
        />
      ))}
    </div>
  );
}

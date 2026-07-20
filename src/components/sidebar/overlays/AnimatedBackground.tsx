import type { CardVisualState } from '../stateColors';
import { colorWithAlpha } from '../stateColors';

export type BackgroundVariant = 'rise' | 'stream';

interface AnimatedBackgroundProps {
  visual: CardVisualState;
  /** 'rise' shows drifting particles (generating); 'stream' shows falling
   *  data streaks (downloading). */
  variant?: BackgroundVariant;
}

const PARTICLES = [0, 1, 2, 3];

const STREAKS = [
  { left: '12%', delay: 0, duration: 1.6 },
  { left: '32%', delay: 0.7, duration: 2.2 },
  { left: '50%', delay: 0.3, duration: 1.8 },
  { left: '70%', delay: 1.1, duration: 1.5 },
  { left: '88%', delay: 0.5, duration: 2 },
];

function RisingParticles({ visual }: { visual: CardVisualState }) {
  const dotColor = colorWithAlpha(visual, 0.6);
  const dotShadow = colorWithAlpha(visual, 0.4);

  return (
    <>
      {PARTICLES.map((i) => (
        <div
          key={i}
 className="absolute left-1/2 -translate-x-1/2 size-1 rounded-full"
          style={{
            bottom: `${12 + i * 20}%`,
            backgroundColor: dotColor,
            boxShadow: `0 0 4px ${dotShadow}`,
            animation: 'generating-particle-rise 2.8s linear infinite',
            animationDelay: `${i * 0.25}s`,
          }}
        />
      ))}
    </>
  );
}

function FallingStreaks({ visual }: { visual: CardVisualState }) {
  const streakColor = colorWithAlpha(visual, 0.7);
  const streakShadow = colorWithAlpha(visual, 0.4);

  return (
    <>
      {STREAKS.map((streak) => (
        <div
          key={streak.left}
          className="absolute top-0 w-px"
          style={{
            left: streak.left,
            height: '30%',
            background: `linear-gradient(to bottom, transparent, ${streakColor})`,
            boxShadow: `0 0 4px ${streakShadow}`,
            animation: `downloading-streak-fall ${streak.duration}s linear infinite`,
            animationDelay: `${streak.delay}s`,
          }}
        />
      ))}
    </>
  );
}

export function AnimatedBackground({ visual, variant = 'rise' }: AnimatedBackgroundProps) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {variant === 'stream' ? <FallingStreaks visual={visual} /> : <RisingParticles visual={visual} />}
    </div>
  );
}

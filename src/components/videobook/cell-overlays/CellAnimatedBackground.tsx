const PARTICLES = [0, 1, 2, 3]

const STREAKS = [
  { left: '12%', delay: 0, duration: 1.6 },
  { left: '32%', delay: 0.7, duration: 2.2 },
  { left: '50%', delay: 0.3, duration: 1.8 },
  { left: '70%', delay: 1.1, duration: 1.5 },
  { left: '88%', delay: 0.5, duration: 2 },
]

export function CellAnimatedBackground({
  variant = 'rise',
}: {
  variant?: 'rise' | 'stream'
}) {
  if (variant === 'stream') {
    return (
      <div className="cell-state-streaks" aria-hidden="true">
        {STREAKS.map((streak) => (
          <span
            key={streak.left}
            className="cell-state-streak"
            style={{
              left: streak.left,
              animationDelay: `${streak.delay}s`,
              animationDuration: `${streak.duration}s`,
            }}
          />
        ))}
      </div>
    )
  }
  return (
    <div className="cell-state-particles" aria-hidden="true">
      {PARTICLES.map((index) => (
        <span
          key={index}
          className="cell-state-particle"
          style={{ animationDelay: `${index * 0.25}s` }}
        />
      ))}
    </div>
  )
}

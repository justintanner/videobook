const PARTICLES = [0, 1, 2, 3]

export function CellAnimatedBackground() {
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

export function NotebookActionBody({
  kindLabel,
  reason,
  stageTitle,
}: {
  kindLabel: string
  reason: string
  stageTitle: string
}) {
  return (
    <div className="confirm-plan">
      <div className="confirm-plan-context">
        <p>{reason}</p>
      </div>
      <ol className="confirm-stages" aria-label="Planned stages">
        <li>
          <span>{kindLabel}</span>
          <strong>{stageTitle}</strong>
        </li>
      </ol>
    </div>
  )
}

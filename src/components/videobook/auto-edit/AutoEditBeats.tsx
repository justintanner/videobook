import { useId } from 'react'
import type { AutoEditSections } from '../../../../server/src/auto-edit/style'
import type { AutoEditBeat } from '@/videobook/auto-edit-review'

export function AutoEditBeats({
  beats,
  sections,
  disabled,
  onSectionChange,
}: {
  beats: readonly AutoEditBeat[]
  sections: AutoEditSections
  disabled: boolean
  onSectionChange: (key: keyof AutoEditSections, enabled: boolean) => void
}) {
  const idPrefix = useId()
  return (
    <section className="auto-edit-panel auto-edit-beats" aria-label="Beats">
      <h3 className="auto-edit-panel-title">Beats</h3>
      <ul>
        {beats.map((beat) => {
          const on = sections[beat.key]
          const detailId = `${idPrefix}-${beat.key}`
          return (
            <li key={beat.key}>
              <label className="auto-edit-beat" data-on={on ? 'true' : 'false'}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={beat.label}
                  aria-describedby={detailId}
                  checked={on}
                  disabled={disabled}
                  onChange={(event) => onSectionChange(beat.key, event.target.checked)}
                />
                <span className="auto-edit-beat-swatch" data-beat={beat.key} aria-hidden="true" />
                <span className="auto-edit-beat-text">
                  <span className="auto-edit-beat-name">{beat.label}</span>
                  <span id={detailId} className="auto-edit-beat-detail">{beat.detail}</span>
                </span>
                <span className="auto-edit-beat-amount">{on ? beat.amount : 'off'}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

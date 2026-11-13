import type { ChangeEvent } from 'react'
import type { AssetRecord } from '@/videobook/workspace-responses'
import type { GoalCharacterChoice } from '@/videobook/goals'

type GoalCharacterPickerProps = {
  choices: readonly GoalCharacterChoice[]
  selected: readonly string[]
  limit: number
  disabled: boolean
  resolveAsset: (artifactId: string) => AssetRecord | null
  onToggle: (artifactId: string) => void
  onUpload: (file: File) => void
}

function ChoiceButton({ choice, pressed, blocked, resolveAsset, onToggle }: {
  choice: GoalCharacterChoice
  pressed: boolean
  blocked: boolean
  resolveAsset: (artifactId: string) => AssetRecord | null
  onToggle: (artifactId: string) => void
}) {
  const asset = resolveAsset(choice.artifactId)
  const url = asset?.thumbnailUrl ?? asset?.mediaUrl
  return <button type="button" className="goal-version goal-character-choice" aria-pressed={pressed} aria-label={`Pick ${choice.address}`} title={choice.label ?? choice.address} disabled={blocked && !pressed} onClick={() => onToggle(choice.artifactId)}>
    {url ? <img src={url} alt="" /> : <span className="goal-media-pending">No preview</span>}
    <span>{choice.address}</span>
    {choice.mentioned && <small>In brief</small>}
  </button>
}

export function GoalCharacterPicker({ choices, selected, limit, disabled, resolveAsset, onToggle, onUpload }: GoalCharacterPickerProps) {
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) onUpload(file)
  }
  return <fieldset className="goal-character-picker" disabled={disabled}>
    <legend>Use an image</legend>
    <p className="goal-panel-muted">Pick up to {limit} pictures of the main character, or upload one. Use them as they are, or generate a character sheet from them.</p>
    <div className="goal-character-choices" role="group" aria-label="Character images">
      {choices.map(choice => <ChoiceButton key={choice.artifactId} choice={choice} pressed={selected.includes(choice.artifactId)} blocked={selected.length >= limit} resolveAsset={resolveAsset} onToggle={onToggle} />)}
      <label className="goal-version goal-character-upload">
        <input type="file" accept="image/*" aria-label="Upload a character image" onChange={upload} />
        <span aria-hidden="true">+</span>
        <span>Upload image</span>
      </label>
    </div>
  </fieldset>
}

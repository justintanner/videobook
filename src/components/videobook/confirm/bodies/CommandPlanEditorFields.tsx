import type { ActionInputSchema } from '../../../../../server/src/workspace-action-contract'
import type { ActionChoice } from '@/videobook/workspace-actions'
import { WorkspaceActionField } from '../../WorkspaceActionField'

export function CommandPlanEditorFields({
  busy,
  choices,
  error,
  values,
  onChange,
  schema,
}: {
  busy: boolean
  choices: Record<string, readonly ActionChoice[]>
  error?: string
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
  schema: ActionInputSchema
}) {
  const required = new Set(schema.required ?? [])
  return (
    <div className="workspace-action-fields confirm-plan-editor">
      {Object.entries(schema.properties ?? {}).map(([name, field]) => (
        <WorkspaceActionField
          key={name}
          name={name}
          schema={field}
          value={values[name]}
          required={required.has(name)}
          disabled={busy}
          choices={choices}
          onChange={(value) => onChange(name, value)}
        />
      ))}
      {error && <p className="confirm-plan-editor-error" role="alert">{error}</p>}
    </div>
  )
}

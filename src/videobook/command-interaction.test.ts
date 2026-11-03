import { describe, expect, it } from 'vitest'
import { scopedEngine } from '../../server/src/engine'
import { buildWorkspaceActionCatalog } from '../../server/src/workspace-action-catalog'
import { getCanonicalCommands } from '../../server/src/tools/commands'
import { getAllToolDefs } from '../../server/src/tools/index'
import { commandOpensPreviewForm, commandRunsAsPreview, fillDirectTarget } from './command-interaction'

describe('slash command interaction dispatch', () => {
  const { actions } = buildWorkspaceActionCatalog(getAllToolDefs(scopedEngine), getCanonicalCommands())
  const action = (command: string) => actions.find((entry) => entry.command === command)!

  it('opens a preview card for a bare preview command and never for a direct one', () => {
    expect(commandOpensPreviewForm(action('/describe'), '')).toBe(true)
    expect(commandRunsAsPreview(action('/describe'))).toBe(true)
    expect(commandOpensPreviewForm(action('/invert'), '')).toBe(false)
    expect(commandRunsAsPreview(action('/invert'))).toBe(false)
  })

  it('runs a direct command on the selected cell or returns an inline hint', () => {
    expect(fillDirectTarget(action('/invert'), {}, 'artifact-1')).toEqual({ ok: true, args: { asset_id: 'artifact-1' } })
    expect(fillDirectTarget(action('/invert'), { asset_id: 'artifact-2' }, 'artifact-1')).toEqual({ ok: true, args: { asset_id: 'artifact-2' } })
    expect(fillDirectTarget(action('/invert'), {}, undefined)).toEqual({ ok: false, message: '/invert: Select a cell or name one, such as @a1.' })
  })
})
